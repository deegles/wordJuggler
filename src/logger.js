'use strict';

var AWS = require('aws-sdk');
var cloudwatchlogs = new AWS.CloudWatchLogs({apiVersion: '2014-03-28'});
var logGroupName = 'WordJugglerUserSessions';

var eventLogger = function() {
    var logEvents = [];
    var lastEventTimestamp = 0;
    var sequenceToken;

    return {
        addEvent: function(message) {
            var now = new Date();
            var timeStamp = now.getTime();
            logEvents.push({
                message: message,
                timestamp: timeStamp
            });
        },

        describeLogStream: function(userId, callback) {
            var params = {
                logGroupName: logGroupName,
                descending: false,
                limit: 1,
                logStreamNamePrefix: userId,
                orderBy: 'LogStreamName'
            };
            cloudwatchlogs.describeLogStreams(params, function(err, data) {
                if (err) {
                    if (err.code === 'ResourceNotFoundException') {
                        createLogStream(userId, function() {
                            callback();
                        });
                    } else {
                        console.log(err, err.stack);
                        callback();
                    }
                } else {
                    var stream = data.logStreams.pop();
                    if (stream && stream['logStreamName']) {
                        sequenceToken = stream['uploadSequenceToken'];
                        lastEventTimestamp = stream['lastEventTimestamp'];
                        callback();
                    } else {
                        createLogStream(userId, function() {
                            callback();
                        });
                    }
                }
            });
        },

        putEventLogs: function(userId, callback) {
            this.describeLogStream(userId, function() {
                var params = {
                    logEvents: logEvents,
                    logGroupName: logGroupName,
                    logStreamName: userId
                };
                if (sequenceToken) {
                    params['sequenceToken'] = sequenceToken;
                }
                cloudwatchlogs.putLogEvents(params, function(err, data) {
                    if (err) {
                        // TODO Add better error handling in case of cloudwatch service errors
                        // (e.g retrying with exponential backoff)
                        console.log('Error: Describing Log Stream Failed ' + JSON.stringify(err, null, 2));
                    }
                    callback();
                });
            });
        }
    };
};

module.exports = eventLogger;

function createLogStream(userId, callback) {
    var params = {
        logGroupName: logGroupName,
        logStreamName: userId
    };
    cloudwatchlogs.createLogStream(params, function(err, data) {
        if (err) {
            console.log('Error: Creating Log Stream Failed ' + JSON.stringify(err, null, 2));
        }
        callback();
    });
}