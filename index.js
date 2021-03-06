var Imap = require('imap'),
    inspect = require('util').inspect;
var MailParser = require('mailparser').MailParser;
var trainTicketParser = require('./12306Parser.js');
var trainTicketDecorator = require('./TicketDecorator.js');
var nodemailer = require('nodemailer');
var Configstore = require('configstore');
var schedule = require('node-schedule');
var config = require('./config');
var htmlToText = require('html-to-text');
var Q = require('q');
/*
[x] 定时任务
[x] 发送邮件
[x] 生成iCal/csv
[x] 设为已读
[x] 定时轮询
[x] 查到站时间
[x] 合并多张
[x] 增加识别改签， 过滤退票
*/

console.log("%s, start service", new Date());
var conf = new Configstore('12306MailParser', {
    lastNo: 0,
    failed: []
});

function checkOnce() {
    var imap = new Imap({
        user: config.email,
        password: config.password,
        host: config.imap.host,
        port: config.imap.port,
        // debug: console.log,
        tls: config.imap.ssl
    });

    imap.once('ready', function() {
        imap.openBox('INBOX', true, function(err, box) {
            if (err) throw err;
            console.log('openInbox, total:' + box.messages.total + ', lastNo:' + conf.get('lastNo'));
            if (conf.get('lastNo') >= box.messages.total) {
                if (conf.get('lastNo') > box.messages.total) {
                    conf.set('lastNo', box.messages.total)
                }
                imap.end();
                return;
            }
            var seqs = [(conf.get('lastNo') + 1) + ':' + box.messages.total];
            seqs = seqs.concat(conf.get('failed'));
            var currentNo = box.messages.total;
            console.log('fetch mail, param=', seqs);
            var f = imap.seq.fetch(seqs, {
                bodies: '',
                markSeen: true
            });
            f.on('message', function(msg, seqno) {
                handleMessage(msg, seqno);
            });
            f.once('error', function(err) {
                console.log('Fetch error: ' + err);
            });
            f.once('end', function() {
                console.log('Done fetching all messages!');
                conf.set('lastNo', currentNo);
                imap.end();
            });
        });
    });
    imap.once('error', function(err) {
        console.log(err);
    });

    imap.once('end', function() {
        console.log('Connection ended');
        imap.end();
    });
    imap.connect();
}

function handleMessage(msg, seqno, cb) {
    console.log('handleMessage, #' + seqno);
    var buffer = new Buffer('');
    var mailparser = new MailParser({
        debug: false,
        defaultCharset: 'utf8'
    });
    mailparser.on('end', function(mail) {
        var mailText;
        if (mail.text) {
            mailText = mail.text;
        } else {
            mailText = htmlToText.fromString(mail.html, {
                wordwrap: false
            });
        }
        if (trainTicketParser.isPaidTicketMail(mailText) || trainTicketParser.isRebookMail(mailText)) {
            console.log('#' + seqno + ' detect ticket mail, parsing...');
            trainTicketParser.parse(mailText)
                .then(function(tickets) {
                    // console.log('#' + seqno + ' parsed:', tickets);
                    return trainTicketDecorator.addArriveTimeAndSchedule(tickets);
                })
                .then(function(tickets) {
                    // console.log('#' + seqno + ' addArriveTimeAndSchedule:', tickets);
                    return trainTicketDecorator.writeMail(tickets);
                })
                .then(function(mailContent) {
                    // console.log('#' + seqno + ' writeMail:', mailContent);
                    return trainTicketDecorator.sendMail(mail.from[0].address, mailContent);
                })
                .catch(function(err) {
                    console.log('#' + seqno + ' error:', err);
                    markFailed(seqno);
                })
                .done(function(result) {
                    console.log('#' + seqno + ' done:', result);
                });
        } else {
            console.log('not interested:' + mail.text);
        }
    })
    msg.on('body', function(stream, info) {
        stream.on('data', function(chunk) {
            buffer = Buffer.concat([buffer, chunk])
        });
        stream.once('end', function() {
            mailparser.write(buffer);
            mailparser.end();
        })
    });
}

function markFailed(seqno) {
    var failed = conf.get('failed');
    failed.push(seqno + '');
    conf.set('failed', failed);
}

function sendMail(email, content, callback) {
    var transporter = nodemailer.createTransport({
        host: config.smtp.host,
        port: config.smtp.port,
        secure: config.smtp.ssl, // use SSL
        auth: {
            user: config.email,
            pass: config.password
        }
    });
    var mailOptions = {
        from: '"parsethatmail" <' + config.email + '>', // sender address
        to: email, // list of receivers
        subject: '12306MailParser result', // Subject line
        text: content.text,
        attachments: [{
            filename: 'event.ics',
            content: new Buffer(content.attachments, 'utf-8')
        }]
    };
    transporter.sendMail(mailOptions, callback);
}

var rule = new schedule.RecurrenceRule();
rule.minute = new schedule.Range(0, 59, config.repeatInMinute);;
schedule.scheduleJob(rule, function() {
    console.log(new Date(), 'Start a new job');
    checkOnce();
});

// checkOnce();
