'use strict';
var Alexa = require('alexa-sdk');
var appId = 'amzn1.ask.skill.0fcabd62-b4b3-479c-a9a7-561d098999fc';
var logger = require('./logger');
var fmt = require('util').format;
var crypto = require('crypto');
var NEWGAME_TIMEOUT_MS = 60 * 60 * 1000; // 60 minutes
var NEWGAME_PROMPT_TIMEOUT_MS = 5 * 60 * 1000;
var words = require('fs').readFileSync('./words/WORDS.txt').toString().split('\n');
var wordCache = {};

var difficultyRanges = {
    veryEasy: {min: 3, max: 3},
    easy: {min: 4, max: 4},
    normal: {min: 3, max: 5},
    medium: {min: 4, max: 6},
    hard: {min: 5, max: 7},
    veryHard: {min: 7, max: 7}
};

var difficultyOpts = {
    'very easy': 'veryEasy',
    'easy': 'easy',
    'normal': 'normal',
    'medium': 'medium',
    'hard': 'hard',
    'very hard': 'veryHard',
};

var easterEggs = {
    'eleven': 'veryHard',
    '11': 'veryHard',
    'ludicrous': 'veryHard',
    'the usual': 'easy',
    'default': 'easy',
    'baby': 'veryEasy',
    'randy': 'veryHard'
};

Object.assign(easterEggs, difficultyOpts);

var exitWords = ['no', 'now', 'know', 'known', 'cancel', 'stop', 'exit', 'quit', 'quite', 'undo'];
var repeatWords = ['repeat', 'again', 'repeat that'];

var difficultyDescriptions = {
    veryEasy: 'three',
    easy: 'four',
    normal: 'three to five',
    medium: 'four to six',
    hard: 'five to seven',
    veryHard: 'seven'
};

exports.handler = function (event, context, callback) {
    var alexa = Alexa.handler(event, context);
    var userId = '';

    if (event.context) {
        userId = event.context.System.user.userId;
    } else {
        userId = event.session.user.userId;
    }

    var succeed = context.succeed;
    var fail = context.fail;

    context.succeed = function (response) {
        if (response && response.response && response.response.outputSpeech) {
            console.log('Speech.... ' + response.response.outputSpeech.ssml ||
                response.response.outputSpeech);
        }

        if (response && response.response && response.response.reprompt) {
            console.log('Reprompt.. ' + response.response.reprompt.outputSpeech.ssml ||
                response.response.reprompt.outputSpeech);
        }

        console.log('Response:\n' + JSON.stringify(response, null, 4));
        cloudWatch.putEventLogs(userId, () => {
            succeed(response);
        });
    };

    context.fail = function (response) {
        console.log('Response:\n' + JSON.stringify(response, null, 4));
        cloudWatch.putEventLogs(userId, () => {
            fail(response);
        });
    };

    process.removeAllListeners('uncaughtException');
    process.on('uncaughtException', function (err) {
        console.log('Uncaught exception:\n' + JSON.stringify(err, null, 4));
        cloudWatch.putEventLogs(userId, () => {
            fail(err);
        });
    });

    alexa.appId = appId;
    alexa.dynamoDBTableName = 'deeglescoSkillUserSessions';
    //alexa.saveBeforeResponse = true;
    alexa.registerHandlers(newSessionHandlers, guessModeHandlers,
        startGameHandlers, guessAttemptHandlers, confirmPromptHandlers);

    var log = console.log;
    var cloudWatch = logger();

    console.log = function (message) {
        log(message);
        cloudWatch.addEvent(message);
    };

    var emit = alexa.emit;

    alexa.emit = function () {
        console.log('Emit: ' + Array.prototype.slice.call(arguments).join(' '));
        emit.apply(this, arguments);
    };

    var emitWithState = alexa.emitWithState;

    alexa.emitWithState = function () {
        console.log('Emit with state: ' + Array.prototype.slice.call(arguments).join(' '));
        emitWithState.apply(this, arguments);
    };

    var stateVal = event.session.attributes;

    Object.defineProperty(alexa, 'state', {
        get () {
            return stateVal['STATE'];
        },
        set (state) {
            console.log('State change: "' + stateVal['STATE'] + '" => "' + state + '"');
            stateVal['STATE'] = state;
        }
    });

    console.log('-----START----- Container Log: ' + context.logGroupName + '/' + context.logStreamName);
    console.log('Event:\n' + JSON.stringify(event, null, 4));

    cloudWatch.describeLogStream(userId, function () {
        alexa.execute();
    });
};

var states = {
    GUESSMODE: '_GUESSMODE', // User is trying to guess the word.
    STARTMODE: '_STARTMODE',  // Prompt the user to start or restart the game.
    CONFIRM_QUIT: '_CONFIRMQUIT' // check if the user wants to exit the game
};

var newSessionHandlers = {
    'NewSession': function () {
        if (!this.attributes['createDate']) {
            this.attributes['createDate'] = new Date().getTime();
            appId ? this.attributes['skillId'] = appId : undefined;
            this.attributes['endedSessionCount'] = 0;
            this.attributes['gamesWon'] = 0;
            this.attributes['difficulty'] = 'easy';
            this.attributes['guesses'] = [];

            this.handler.state = states.STARTMODE;
            var text = 'Welcome to Word Juggler. In this game you try to guess a secret word ' +
                'using only clues about it\'s alphabetical ordering. When you guess a word, I will tell you if it ' +
                'comes before or after, alphabetically. Your last five guesses are displayed %s. ' +
                'You can change the difficulty of the game by saying %schange difficulty%s ';
            var prompt = 'Do you want to start a new game?';
            return this.emit(':askWithCard', fmt(text, 'in the companion app', '<p>', '</p>') + prompt,
                'Say yes to start the game or help for more instructions.',
                'Word Juggler', fmt(text, 'here', '"', '"'));
        }

        this.attributes['lastEventTime'] = new Date().getTime();
        var eventString = '';

        if (this.attributes['targetWord']) {
            console.log('New session, target word is set: ' + this.attributes['targetWord']);
            this.handler.state = states.GUESSMODE;
            return this.emitWithState('NewSession');
        } else if (this.event.request.type === 'LaunchRequest') {
            eventString = 'LaunchRequest';
        } else if (this.event.request.type === 'IntentRequest') {
            eventString = this.event.request.intent.name;
        }

        if (this.handler.listenerCount(eventString) < 1) {
            eventString = 'Unhandled';
        }

        this.emit(eventString);
    },
    'LaunchRequest': function () {
        this.attributes['lastEventTime'] = new Date().getTime();
        this.handler.state = states.STARTMODE;

        var speech = 'Welcome to Word Juggler. ';

        if (this.attributes['gamesWon'] === 1) {
            speech += 'You have won ' + this.attributes['gamesWon'].toString() + ' game. ';
        } else if (this.attributes['gamesWon'] > 1) {
            speech += 'You have won ' + this.attributes['gamesWon'].toString() + ' games. ';
        }

        speech += 'Would you like to play a new game?';

        this.emit(':ask', speech, 'Say yes to start the game or help for more instructions.');
    },
    'ChangeDifficultyIntent': function (override) {
        this.attributes['lastEventTime'] = new Date().getTime();
        var difficulty = override;

        if (override) {
            console.log('Difficulty override: ' + override);
        }

        if (this.event.request.intent && this.event.request.intent.slots.difficulty) {
            difficulty = this.event.request.intent.slots.difficulty.value;
        }

        if (Object.keys(easterEggs).indexOf(difficulty) > -1) {
            this.attributes['difficulty'] = easterEggs[difficulty];
            console.log('starting new game at difficulty:' + this.attributes['difficulty']);
            this.handler.state = states.STARTMODE;
            this.emitWithState('AMAZON.YesIntent');
        } else {
            var option = Object.keys(difficultyOpts)[Math.floor(Math.random() * Object.keys(difficultyOpts).length)];
            var speech = 'Which difficulty level would you like to play at?';
            var reprompt = 'Try saying <p>' + option + '</p>';
            if (difficulty) {
                speech = 'Sorry, ' + difficulty + ' is not a valid difficulty level. ';
            }
            this.emit(':ask', speech + reprompt, reprompt);
        }
    },
    'WordGuessIntent': function () {
        var guessWord = this.event.request.intent.slots.word.value;

        console.log('Raw word detected: ' + guessWord);

        if (this.event.session && this.event.session['new'] && this.attributes['targetWord']) {
            this.handler.state = states.GUESSMODE;
            this.emitWithState('WordGuessIntent');
        } else if (this.event.session && this.event.session['new'] && !this.attributes['targetWord']) {
            this.handler.state = states.STARTMODE;
            this.emitWithState('LaunchRequest');
        } else if (Object.keys(easterEggs).indexOf(guessWord) > -1) {
            this.emit('ChangeDifficultyIntent', guessWord);
        } else if (guessWord.indexOf('help') > -1) {
            console.log('this should never happen!!');
            this.emit('AMAZON.HelpIntent');
        } else if (guessWord && exitWords.indexOf(guessWord.toLowerCase()) >= 0) {
            this.handler.state = states.GUESSMODE;
            this.emit(':ask', 'Ok, what is your guess?', 'Say any word to continue.');
        } else {
            this.emit('ChangeDifficultyIntent', guessWord);
        }
    },
    'AMAZON.CancelIntent': function () {
        this.handler.state = states.STARTMODE;
        this.emitWithState('AMAZON.YesIntent');
    },
    'AMAZON.StartOverIntent': function () {
        this.handler.state = states.STARTMODE;
        this.emitWithState('AMAZON.YesIntent');
    },
    'AMAZON.HelpIntent': function () {
        this.handler.state = states.STARTMODE;
        this.emitWithState('AMAZON.HelpIntent');
    },
    'WhoAmIIntent': function () {
        var userId = '';

        if (this.event.session) {
            userId = this.event.session.user.userId;
        } else {
            userId = this.event.context.System.user.userId;
        }

        var uniqueId = getUniqueIdString(userId);

        console.log('Unique ID requested: ' + uniqueId + ' for user ' + userId);

        var speech = 'Your unique eye dee is: <break time="250ms"/> ' +
            uniqueId.split(' ').join('<break time="250ms"/> ') + '. ';
        var reprompt = '<break time="500ms"/>Mention it in your review or email ' +
            'to help Word Juggler troubleshoot your issue.';

        var cardTitle = 'Word Juggler';
        var cardText = 'Your unique ID for troubleshooting is:\n\n' + uniqueId + '. \n\nMention it in your review or ' +
            'email to wordjuggler@deegles.co to help us pinpoint your issue.';

        this.attributes['speech'] = speech;
        this.attributes['reprompt'] = reprompt;

        this.emit(':askWithCard', speech + reprompt, reprompt, cardTitle, cardText);
    },
    'Unhandled': function () {
        this.emit('LaunchRequest');
    }
};

var startGameHandlers = Alexa.CreateStateHandler(states.STARTMODE, {
    'NewSession': function () {
        this.emit('NewSession');
    },
    'AMAZON.HelpIntent': function () {
        var options = ['very easy', 'easy', 'normal', 'medium', 'hard', 'very hard'];
        var option = options[Math.floor(Math.random() * options.length)];
        var speech = 'I will think of a ' + difficultyDescriptions[this.attributes['difficulty']] + ' letter word, ' +
            'and you will try to guess what it is. I will tell you if your guess comes before or after, ' +
            'alphabetically. You can also change the difficulty by saying, change difficulty to ' + option + '. ' +
            'Would you like to start a new game?';
        var reprompt = 'Say yes to start the game, or say change difficulty';

        this.attributes['speech'] = speech;
        this.attributes['reprompt'] = reprompt;

        this.emit(':ask', speech, reprompt);
    },
    'AMAZON.YesIntent': function () {
        this.attributes['targetWord'] = selectWord(this.attributes['difficulty']);
        this.attributes['guesses'] = [];
        this.attributes['guessCount'] = 0;
        this.attributes['lastEventTime'] = new Date().getTime();
        delete this.attributes['lastGuess'];

        console.log('Target word: ' + this.attributes['targetWord']);

        this.handler.state = states.GUESSMODE;
        var speech = 'Great! I\'m thinking of a ' + difficultyDescriptions[this.attributes['difficulty']] +
            ' letter word. Try saying a word to start the game.';
        var reprompt = 'Try saying a ' + difficultyDescriptions[this.attributes['difficulty']] + ' letter word.';

        this.attributes['speech'] = speech;
        this.attributes['reprompt'] = reprompt;

        this.emit(':ask', speech, reprompt);
    },
    'AMAZON.NoIntent': function () {
        delete this.attributes['speech'];
        delete this.attributes['reprompt'];

        this.emit(':tell', 'Ok, see you next time!');
    },
    'AMAZON.CancelIntent': function () {
        this.handler.state = states.STARTMODE;
        this.emitWithState('AMAZON.NoIntent');
    },
    'AMAZON.StartOverIntent': function () {
        logAbandon(this.attributes['targetWord'], this.attributes['guessCount'] || 0, 'USER_INITIATED');
        this.emitWithState('AMAZON.YesIntent');
    },
    'ChangeDifficultyIntent': function () {
        this.handler.state = '';
        this.emit('ChangeDifficultyIntent');
    },
    'SessionEndedRequest': function () {
        console.log('session ended!');
        delete this.attributes['speech'];
        delete this.attributes['reprompt'];

        this.attributes['endedSessionCount'] += 1;
        this.emit(':saveState', true);
    },
    'AMAZON.RepeatIntent': function () {
        this.emit(':ask', this.attributes['speech'], this.attributes['reprompt']);
    },
    'WordGuessIntent': function () {
        var guessWord = this.event.request.intent.slots.word.value;

        console.log('Raw word detected: ' + guessWord);

        if (guessWord && exitWords.indexOf(guessWord.toLowerCase()) >= 0) {
            this.emitWithState('AMAZON.NoIntent');
        } else if (guessWord.indexOf('help') > -1) {
            console.log('this should never happen!!');
            this.emitWithState('AMAZON.HelpIntent');
        } else if (guessWord && repeatWords.indexOf(guessWord.toLowerCase()) >= 0) {
            console.log('caught repeat intent...');
            return this.emitWithState('AMAZON.RepeatIntent');
        } else {
            this.emitWithState('Unhandled');
        }
    },
    'WhoAmIIntent': function () {
        this.emit('WhoAmIIntent');
    },
    'Unhandled': function () {
        var message = 'Say yes to start a game or no to exit, or say help.';

        this.attributes['speech'] = message;
        this.attributes['reprompt'] = message;

        this.emit(':ask', message, message);
    }
});

var guessModeHandlers = Alexa.CreateStateHandler(states.GUESSMODE, {
    'NewSession': function () {
        var t = new Date().getTime();
        var diff = t - this.attributes['lastEventTime'];

        if (diff >= NEWGAME_TIMEOUT_MS) {
            console.log('Game Timed Out');
            logAbandon(this.attributes['targetWord'], this.attributes['guessCount'] || 0, 'TIMEOUT');
            delete this.attributes['targetWord'];
            return this.emit('NewSession');
        }

        this.attributes['lastEventTime'] = new Date().getTime();
        var eventString = '';

        if (this.event.request.type === 'LaunchRequest') {
            eventString = 'LaunchRequest';
        } else if (this.event.request.type === 'IntentRequest') {
            eventString = this.event.request.intent.name;
        }

        if (this.handler.listenerCount(eventString) < 1) {
            eventString = 'Unhandled';
        }

        this.emitWithState(eventString);
    },
    'LaunchRequest': function () {
        var t = new Date().getTime();
        var diff = t - this.attributes['lastEventTime'];
        var speech = '';

        if (diff >= NEWGAME_PROMPT_TIMEOUT_MS) {
            speech = 'You have a game in progress. The target is a ' +
                difficultyDescriptions[this.attributes['difficulty']] + ' letter word. ';
        }

        if (this.attributes['lastGuess']) {
            speech += 'Your last guess was, ' + this.attributes['lastGuess'] + '. ';
        }

        speech += 'say a word to continue.';

        var reprompt = 'You can also say start over to begin a new game.';

        this.attributes['speech'] = speech;
        this.attributes['reprompt'] = reprompt;

        this.emit(':ask', speech, reprompt);
    },
    'WordGuessIntent': function () {
        this.attributes['lastEventTime'] = new Date().getTime();
        var guessWord = this.event.request.intent.slots.word.value;
        var target = this.attributes['targetWord'];

        if (guessWord && exitWords.indexOf(guessWord.toLowerCase()) >= 0) {
            var speech = 'You said <p>' + guessWord + '</p> do you want to keep playing?';
            var reprompt = 'Say yes to continue playing or no to quit the game. Say start over to start a new game.';

            this.attributes['speech'] = speech;
            this.attributes['reprompt'] = reprompt;

            this.handler.state = states.CONFIRM_QUIT;
            return this.emit(':ask', speech, reprompt);
        } else if (guessWord && repeatWords.indexOf(guessWord.toLowerCase()) >= 0) {
            console.log('caught repeat intent...');
            return this.emitWithState('AMAZON.RepeatIntent');
        }

        if (guessWord) {
            guessWord = guessWord.toLowerCase();
            this.attributes['lastGuess'] = guessWord;
            logGuess(guessWord);
            console.log('target: ' + target + ', user guessed: ' + guessWord);
        }

        if (guessWord > target) { // 'aac' > 'aaa'
            this.attributes['guessCount']++;
            this.emit('TooLow', guessWord);
        } else if (guessWord < target) { // 'aaa' < 'aac'
            this.attributes['guessCount']++;
            this.emit('TooHigh', guessWord);
        } else if (guessWord === target) {
            this.attributes['guessCount']++;
            delete this.attributes['lastGuess'];
            delete this.attributes['targetWord'];
            this.handler.state = states.STARTMODE;
            this.emit('JustRight', guessWord);
        } else {
            this.emit('NotAWord');
        }
    },
    'ChangeDifficultyIntent': function () {
        this.handler.state = '';
        this.emit('ChangeDifficultyIntent');
    },
    'AMAZON.HelpIntent': function () {
        var options = ['very easy', 'easy', 'normal', 'medium', 'hard', 'very hard'];
        var option = options[Math.floor(Math.random() * options.length)];
        var speech = 'I am thinking of a ' + difficultyDescriptions[this.attributes['difficulty']] + ' letter word, ' +
            'try to guess what it is and I will tell you if your guess comes before or after, alphabetically. Check ' +
            'the companion app to see your previous guesses. You' +
            ' can also change the difficulty by saying, "change difficulty to ' + option + '" or start over at ' +
            'any time by saying "start over"';
        var reprompt = 'Try saying a word, "start over", or "change difficulty"';

        this.attributes['speech'] = speech;
        this.attributes['reprompt'] = reprompt;

        this.emit(':ask', speech, reprompt);
    },
    'AMAZON.StartOverIntent': function () {
        this.handler.state = states.STARTMODE;
        this.emitWithState('AMAZON.YesIntent');
    },
    'AMAZON.CancelIntent': function () {
        var speech = 'You said <p>cancel</p> do you want to keep playing?';
        var reprompt = 'Say yes to continue playing or no to quit the game. Say start over to start a new game.';

        this.attributes['speech'] = speech;
        this.attributes['reprompt'] = reprompt;

        this.handler.state = states.CONFIRM_QUIT;
        return this.emit(':ask', speech, reprompt);
    },
    'AMAZON.RepeatIntent': function () {
        if (!this.attributes['speech'] || !this.attributes['reprompt']) {
            this.emitWithState('LaunchRequest');
        } else {
            this.emit(':ask', this.attributes['speech'], this.attributes['reprompt']);
        }
    },
    'SessionEndedRequest': function () {
        console.log('session ended!');
        delete this.attributes['speech'];
        delete this.attributes['reprompt'];

        this.attributes['endedSessionCount'] += 1;
        this.emit(':saveState', true);
    },
    'WhoAmIIntent': function () {
        this.emit('WhoAmIIntent');
    },
    'Unhandled': function () {
        this.attributes['speech'] = 'Sorry, I didn\'t get that. Try saying a word.';
        this.attributes['reprompt'] = 'Try saying any word.';

        this.emit(':ask', this.attributes['speech'], this.attributes['reprompt']);
    }
});

var confirmPromptHandlers = Alexa.CreateStateHandler(states.CONFIRM_QUIT, {
    'NewSession': function () {
        this.emit('NewSession');
    },
    'AMAZON.NoIntent': function () {
        delete this.attributes['speech'];
        delete this.attributes['reprompt'];

        this.emit(':tell', 'Ok, let\'s continue later!');
    },
    'AMAZON.CancelIntent': function () {
        this.emitWithState('AMAZON.YesIntent');
    },
    'AMAZON.YesIntent': function () {
        this.handler.state = states.GUESSMODE;

        var speech = 'Ok, what is your guess?';
        var reprompt = 'Say any word to continue.';

        this.attributes['speech'] = speech;
        this.attributes['reprompt'] = reprompt;

        this.emit(':ask', speech, reprompt);
    },
    'AMAZON.HelpIntent': function () {
        var speech = 'Say yes to continue your game. You can also say <p>no</p> to exit or ' +
            '<p>start over</p> to begin a new game.';
        var reprompt = 'say <p>start over</p> to begin a new game.';

        this.attributes['speech'] = speech;
        this.attributes['reprompt'] = reprompt;

        this.emit(':ask', speech, reprompt);
    },
    'AMAZON.StartOverIntent': function () {
        this.handler.state = states.STARTMODE;
        logAbandon(this.attributes['targetWord'], this.attributes['guessCount'], 'USER_INITIATED');
        this.emitWithState('AMAZON.YesIntent');
    },
    'AMAZON.RepeatIntent': function () {
        this.emit(':ask', this.attributes['speech'], this.attributes['reprompt']);
    },
    'WordGuessIntent': function () {
        var guessWord = this.event.request.intent.slots.word.value;

        console.log('Raw word detected: ' + guessWord);

        if (guessWord && exitWords.indexOf(guessWord.toLowerCase()) >= 0) {
            this.emitWithState('AMAZON.NoIntent');
        } else if (guessWord.indexOf('help') > -1) {
            console.log('this should never happen!!');
            this.emitWithState('AMAZON.HelpIntent');
        } else {
            this.emitWithState('Unhandled');
        }
    },
    'SessionEndedRequest': function () {
        delete this.attributes['speech'];
        delete this.attributes['reprompt'];

        console.log('session ended!');
        this.attributes['endedSessionCount'] += 1;
        this.emit(':saveState', true);
    },
    'WhoAmIIntent': function () {
        this.emit('WhoAmIIntent');
    },
    'Unhandled': function () {
        this.attributes['speech'] = 'Sorry, I didn\'t get that. Say yes to keep playing or no to quit.';
        this.attributes['reprompt'] = 'You can also say help.';

        this.emit(':ask', this.attributes['speech'], this.attributes['reprompt']);
    }
});

// These handlers are not bound to a state
// askWithCard = speechOutput, repromptSpeech, cardTitle, cardContent, imageObj

var guessAttemptHandlers = {
    'TooHigh': function (val) {
        var cardText = '';
        var cardTitle = 'Your guess: ' + val;

        var guessText = `${val.toUpperCase()} is before the secret word.\n`;
        this.attributes['guesses'].push(guessText);

        if (this.attributes['guesses'].length > 1) {
            for (var i = 0; i < this.attributes['guesses'].length - 1; i++) {
                cardText = this.attributes['guesses'][i] + '\n' + cardText;
            }
            cardText = '\nPrevious:\n' + cardText;
        }

        if (this.attributes['guesses'].length >= 6) {
            this.attributes['guesses'] = this.attributes['guesses'].slice(1);
        }

        var clue = 'Try saying a word that would be ranked later than <p>' + val.toString() +
            '</p>  in an alphabetical list.';

        var cardClue = 'The secret word is ' + difficultyDescriptions[this.attributes['difficulty']] +
            ' letters long.\n\n' + guessText;

        var speech = '<audio src="https://s3.amazonaws.com/deeglescosounds/incorrect_high.mp3" /> ' +
            val.toString() + ' comes before.';
        var reprompt = clue;

        this.attributes['speech'] = speech;
        this.attributes['reprompt'] = reprompt;

        this.emit(':askWithCard', speech, reprompt, cardTitle, (cardClue + cardText));
    },
    'TooLow': function (val) {
        var cardText = '';
        var cardTitle = 'Your guess: ' + val;

        var guessText = `${val.toUpperCase()} is after the secret word.\n\n`;
        this.attributes['guesses'].push(guessText);

        if (this.attributes['guesses'].length > 1) {
            for (var i = 0; i < this.attributes['guesses'].length - 1; i++) {
                cardText = this.attributes['guesses'][i] + '\n' + cardText;
            }
            cardText = 'Previous:\n' + cardText;
        }

        if (this.attributes['guesses'].length >= 6) {
            this.attributes['guesses'] = this.attributes['guesses'].slice(1);
        }

        var clue = 'Try saying a word that would be ranked earlier than <p>' + val.toString() +
            '</p> in an alphabetical list.';

        var cardClue = 'The secret word is ' + difficultyDescriptions[this.attributes['difficulty']] +
            ' letters long.\n\n' + guessText;

        var speech = '<audio src="https://s3.amazonaws.com/deeglescosounds/incorrect_low.mp3" />' +
            val.toString() + ' comes after.';
        var reprompt = clue;

        this.attributes['speech'] = speech;
        this.attributes['reprompt'] = reprompt;

        this.emit(':askWithCard', speech, reprompt, cardTitle, (cardClue + cardText));
    },
    'JustRight': function (val) {
        var cardTitle = 'You win!';

        this.handler.state = states.STARTMODE;
        this.attributes['gamesWon']++;

        var cardText = 'Your guess:\n' + val + '\n\n Correct!' +
            '\nGames won:   ' + this.attributes['gamesWon'] +
            '\nGuess count: ' + this.attributes['guessCount'];

        var winText = '';

        logWin(val, this.attributes['guessCount']);

        this.attributes['guesses'] = [];
        this.attributes['guessCount'] = 0;

        if (this.attributes['gamesWon'] === 1) {
            winText += 'You have won ' + this.attributes['gamesWon'].toString() + ' game. ';
        } else if (this.attributes['gamesWon'] > 1) {
            winText += 'You have won ' + this.attributes['gamesWon'].toString() + ' games. ';
        }

        var speech = '<audio src="https://s3.amazonaws.com/deeglescosounds/correct.mp3" /> ' + val.toString() +
            ' is correct! ' + winText + ' Would you like to play a new game?';
        var reprompt = 'Say yes to start a new game, or no to end the game.';

        this.attributes['speech'] = speech;
        this.attributes['reprompt'] = reprompt;

        this.emit(':askWithCard', speech, reprompt, cardTitle, cardText);

    },
    'NotAWord': function () {
        var speech = 'Sorry, I didn\'t get that. Try saying a word.';
        var reprompt = 'Try saying a ' + difficultyDescriptions[this.attributes['difficulty']] + ' letter word.';

        this.attributes['speech'] = speech;
        this.attributes['reprompt'] = reprompt;

        this.emit(':ask', speech, reprompt);
    }
};

function selectWord(difficulty) {
    var wordList = getWordlist(difficulty);
    return wordList[Math.floor(Math.random() * wordList.length)];
}

function getWordlist(difficulty) {
    if (!wordCache[difficulty]) {
        wordCache[difficulty] = words.filter(function (word) {
            return word.length >= difficultyRanges[difficulty]['min'] &&
                word.length <= difficultyRanges[difficulty]['max'];
        });
    }
    return wordCache[difficulty];
}

function getUniqueIdString(userId) {
    var wordCount = 3;
    var bytes = crypto.createHash('sha512').update(userId).digest();
    var value = new Array(wordCount);
    var len = words.length;

    for (var i = 0; i <= wordCount; i++) {
        value[i] = words[bytes[bytes.length - i] % len];
    }

    return value.join(' ').toUpperCase();
}

function logGuess(word) {
    var obj = {
        eventType: 'Guess',
        word: word,
        length: word ? word.length : undefined,
        timestamp: new Date().getTime()
    };

    console.log(JSON.stringify(obj));
}

function logWin(word, guessCount) {
    var obj = {
        eventType: 'Win',
        word: word,
        length: word ? word.length : undefined,
        guesses: guessCount,
        timestamp: new Date().getTime()
    };

    console.log(JSON.stringify(obj));
}

function logAbandon(word, guessCount, reason) {
    var obj = {
        eventType: 'Abandon',
        word: word,
        length: word ? word.length : undefined,
        guesses: guessCount,
        reason: reason,
        timestamp: new Date().getTime()
    };

    console.log(JSON.stringify(obj));
}