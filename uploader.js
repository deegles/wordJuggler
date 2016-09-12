'use strict';

var startTime = new Date().getTime();
var fs = require('fs');
var archiver = require('archiver');
var zipPath = './juggler.zip';

var output = fs.createWriteStream(zipPath);
var archive = archiver('zip');

process.stdout.write('Zipping');

var dot = setInterval(function() {
    process.stdout.write('.');
}, 250);

output.on('close', function() {
    clearInterval(dot);
    console.log(' Done!\n' + archive.pointer() + ' bytes zipped.\nZip time: ' + ((new Date().getTime() - startTime) / 1000).toFixed(2) + 's');
    process.stdout.write('\nUploading to Lambda... ');
    startTime = new Date().getTime();
    update();
});

archive.on('error', function(err) {
    throw err;
});

archive.pipe(output);
archive.bulk([
    {expand: true, cwd: './src/', src: ['**'], dest: ''}
]);

archive.finalize();

var aws = require('aws-sdk');
var credentials = new aws.SharedIniFileCredentials({profile: 'personal-deegles'});
aws.config.credentials = credentials;

var lambda = new aws.Lambda({apiVersion: '2015-03-31', region: 'us-east-1'});

var lambdaARN = 'arn:aws:lambda:us-east-1:594681367028:function:wordJuggler';

function update() {
    var params = {
        FunctionName: lambdaARN,
        Publish: true,
        ZipFile: fs.readFileSync(zipPath)
    };

    var dance = setInterval(function() {
        process.stdout.write(dances[Math.floor(Math.random() * dances.length )] + ' ');
    }, 500);

    lambda.updateFunctionCode(params, function(err, data) {
        clearInterval(dance);
        if (err) {
            console.log(err, err.stack);
        } else {

            console.log('Success!\nUpload time: ' + ((new Date().getTime() - startTime) / 1000).toFixed(2) + 's');
            //console.log(data);
        }
        fs.unlinkSync(zipPath);
    });
}

var dances = ['♬', 'ヘ(￣ω￣ヘ)', '(ノ￣ー￣)ノ', 'ヘ(￣ー￣ヘ)', '(ノ^_^)ノ', '(ノ￣ω￣)ノ', '＼(ﾟｰﾟ＼)', 'ヾ(･ω･)ﾉ',
    '└( ＾ω＾ )」', '(~‾▿‾)~', '〜(￣△￣〜)', '~(‾▿‾)~'];