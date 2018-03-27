"use strict";
(function discordio(Discord){
var isNode = typeof(window) === "undefined" && typeof(navigator) === "undefined";
var CURRENT_VERSION = "2.x.x",
    GATEWAY_VERSION = 6,
    LARGE_THRESHOLD = 250,
    CONNECT_WHEN = null,
    Endpoints, Payloads;

if (isNode) {
    var Util        = require('util'),
        FS          = require('fs'),
        UDP         = require('dgram'),
        Zlib        = require('zlib'),
        DNS         = require('dns'),
        Stream      = require('stream'),
        BN          = require('path').basename,
        EE          = require('events').EventEmitter,
        requesters  = {
            http:     require('http'),
            https:    require('https')
        },
        ChildProc   = require('child_process'),
        URL         = require('url'),
        //NPM Modules
        NACL        = require('tweetnacl'),
        Opus        = null;
}

/* --- Version Check --- */
try {
	CURRENT_VERSION = require('../package.json').version;
} catch(e) {}
if (!isNode) CURRENT_VERSION = CURRENT_VERSION + "-browser";

/**
 * Discord Client constructor
 * @class
 * @arg {Object} options
 * @arg {String} options.token - The token of the account you wish to log in with.
 * @arg {Boolean} [options.autorun] - If true, the client runs when constructed without calling `.connect()`.
 * @arg {Number} [options.messageCacheLimit] - The amount of messages to cache in memory, per channel. Used for information on deleted/updated messages. The default is 50.
 * @arg {Array<Number>} [options.shard] - The shard array. The first index is the current shard ID, the second is the amount of shards that should be running.
 */
Discord.Client = function DiscordClient(options) {
	if (!isNode) Emitter.call(this);
	if (!options || options.constructor.name !== 'Object') return console.error("An Object is required to create the discord.io client.");

	applyProperties(this, [
		["_ws", null],
		["_uIDToDM", {}],
		["_ready", false],
		["_vChannels", {}],
		["_messageCache", {}],
		["_connecting", false],
		["_mainKeepAlive", null],
		["_req", APIRequest.bind(this)], 
		["_shard", validateShard(options.shard)],
		["_messageCacheLimit", typeof(options.messageCacheLimit) === 'number' ? options.messageCacheLimit : 50],
	]);

	this.presenceStatus = "offline";
	this.connected = false;
	this.inviteURL = null;
	// this.connect = this.connect.bind(this, options);
  this.token=options.token

	// if (options.autorun === true) this.connect();
};
if (isNode) Emitter.call(Discord.Client);

/* - DiscordClient - Methods - */
var DCP = Discord.Client.prototype;

/**
 * Retrieve a user object from Discord, Bot only endpoint. You don't have to share a server with this user.
 * @arg {Object} input
 * @arg {Snowflake} input.userID
 */
DCP.getUser = function(input, callback) {
	if (!this.bot) return handleErrCB("[getUser] This account is a 'user' type account, and cannot use 'getUser'. Only bots can use this endpoint.", callback);
	this._req('get', Endpoints.USER(input.userID), function(err, res) {
		handleResCB("Could not get user", err, res, callback);
	});
};

/**
 * Edit the client's user information.
 * @arg {Object} input
 * @arg {String<Base64>} input.avatar - The last part of a Base64 Data URI. `fs.readFileSync('image.jpg', 'base64')` is enough.
 * @arg {String} input.username - A username.
 * @arg {String} input.email - [User only] An email.
 * @arg {String} input.password - [User only] Your current password.
 * @arg {String} input.new_password - [User only] A new password.
 */
DCP.editUserInfo = function(input, callback) {
	var payload = {
		avatar: this.avatar,
		email: this.email,
		new_password: null,
		password: null,
		username: this.username
	},
		plArr = Object.keys(payload);

	for (var key in input) {
		if (plArr.indexOf(key) < 0) return handleErrCB(("[editUserInfo] '" + key + "' is not a valid key. Valid keys are: " + plArr.join(", ")), callback);
		payload[key] = input[key];
	}
	if (input.avatar) payload.avatar = "data:image/jpg;base64," + input.avatar;

	this._req('patch', Endpoints.ME, payload, function(err, res) {
		handleResCB("Unable to edit user information", err, res, callback);
	});
};

/**
 * Change the client's presence.
 * @arg {Object} input
 * @arg {String|null} input.status - Used to set the status. online, idle, dnd, invisible, and offline are the possible states.
 * @arg {Number|null} input.since - Optional, use a Number before the current point in time.
 * @arg {Boolean|null} input.afk - Optional, changes how Discord handles push notifications.
 * @arg {Object|null} input.game - Used to set game information.
 * @arg {String|null} input.game.name - The name of the game.
 * @arg {Number|null} input.game.type - Activity type, 0 for game, 1 for Twitch.
 * @arg {String|null} input.game.url - A URL matching the streaming service you've selected.
 */
DCP.setPresence = function(input) {
	var payload = Payloads.STATUS(input);
	send(this._ws, payload);

	if (payload.d.since === null) return void(this.presenceStatus = payload.d.status);
	this.presenceStatus = payload.d.status;
};

/**
 * Receive OAuth information for the current client.
 */
DCP.getOauthInfo = function(callback) {
	this._req('get', Endpoints.OAUTH, function(err, res) {
		handleResCB("Error GETing OAuth information", err, res, callback);
	});
};

/**
 * Receive account settings information for the current client.
 */
DCP.getAccountSettings = function(callback) {
	this._req('get', Endpoints.SETTINGS, function(err, res) {
		handleResCB("Error GETing client settings", err, res, callback);
	});
};

/* - DiscordClient - Methods - Content - */

/**
 * Upload a file to a channel.
 * @arg {Object} input
 * @arg {Snowflake} input.to - The target Channel or User ID.
 * @arg {Buffer|String} input.file - A Buffer containing the file data, or a String that's a path to the file.
 * @arg {String|null} input.filename - A filename for the uploaded file, required if you provide a Buffer.
 * @arg {String|null} input.message - An optional message to provide.
 */
DCP.uploadFile = function(input, callback) {
	/* After like 15 minutes of fighting with Request, turns out Discord doesn't allow multiple files in one message...
	despite having an attachments array.*/
	var file, client, multi, message, isBuffer, isString;

	client = this;
	multi = new Multipart();
	message = generateMessage(input.message || "");
	isBuffer = (input.file instanceof Buffer);
	isString = (type(input.file) === 'string');

	if (!isBuffer && !isString) return handleErrCB("uploadFile requires a String or Buffer as the 'file' value", callback);
	if (isBuffer) {
		if (!input.filename) return handleErrCB("uploadFile requires a 'filename' value to be set if using a Buffer", callback);
		file = input.file;
	}
	if (isString) try { file = FS.readFileSync(input.file); } catch(e) { return handleErrCB("File does not exist: " + input.file, callback); }

	[
		["content", message.content],
		["mentions", ""],
		["tts", false],
		["nonce", message.nonce],
		["file", file, input.filename || BN(input.file)]
	].forEach(multi.append, multi);
	multi.finalize();

	resolveID(client, input.to, function(channelID) {
		client._req('post', Endpoints.MESSAGES(channelID), multi, function(err, res) {
			handleResCB("Unable to upload file", err, res, callback);
		});
	});
};

/**
 * Send a message to a channel.
 * @arg {Object} input
 * @arg {Snowflake} input.to - The target Channel or User ID.
 * @arg {String} input.message - The message content.
 * @arg {Object} [input.embed] - An embed object to include
 * @arg {Boolean} [input.tts] - Enable Text-to-Speech for this message.
 * @arg {Number} [input.nonce] - Number-used-only-ONCE. The Discord client uses this to change the message color from grey to white.
 * @arg {Boolean} [input.typing] - Indicates whether the message should be sent with simulated typing. Based on message length.
 */
DCP.sendMessage = function(input, callback) {
	var message = generateMessage(input.message || '', input.embed);
	message.tts = (input.tts === true);
	message.nonce = input.nonce || message.nonce;

	if (input.typing === true) {
		return simulateTyping(
			this,
			input.to,
			message,
			( (message.content.length * 0.12) * 1000 ),
			callback
		);
	}

	sendMessage(this, input.to, message, callback);
};

/**
 * Pull a message object from Discord.
 * @arg {Object} input
 * @arg {Snowflake} input.channelID - The channel ID that the message is from.
 * @arg {Snowflake} input.messageID - The ID of the message.
 */
DCP.getMessage = function(input, callback) {
	this._req('get', Endpoints.MESSAGES(input.channelID, input.messageID), function(err, res) {
		handleResCB("Unable to get message", err, res, callback);
	});
};

/**
 * Pull an array of message objects from Discord.
 * @arg {Object} input
 * @arg {Snowflake} input.channelID - The channel ID to pull the messages from.
 * @arg {Number} [input.limit] - How many messages to pull, defaults to 50.
 * @arg {Snowflake} [input.before] - Pull messages before this message ID.
 * @arg {Snowflake} [input.after] - Pull messages after this message ID.
 */
DCP.getMessages = function(input, callback) {
	var client = this, qs = {}, messages = [], lastMessageID = "";
	var total = typeof(input.limit) !== 'number' ? 50 : input.limit;

	if (input.before) qs.before = input.before;
	if (input.after) qs.after = input.after;

	(function getMessages() {
		if (total > 100) {
			qs.limit = 100;
			total = total - 100;
		} else {
			qs.limit = total;
		}

		if (messages.length >= input.limit) return call(callback, [null, messages]);

		client._req('get', Endpoints.MESSAGES(input.channelID) + qstringify(qs), function(err, res) {
			if (err) return handleErrCB("Unable to get messages", callback);
			messages = messages.concat(res.body);
			lastMessageID = messages[messages.length - 1] && messages[messages.length - 1].id;
			if (lastMessageID) qs.before = lastMessageID;
			if (!res.body.length < qs.limit) return call(callback, [null, messages]);
			return setTimeout(getMessages, 1000);
		});
	})();
};

/**
 * Edit a previously sent message.
 * @arg {Object} input
 * @arg {Snowflake} input.channelID
 * @arg {Snowflake} input.messageID
 * @arg {String} input.message - The new message content
 * @arg {Object} [input.embed] - The new Discord Embed object
 */
DCP.editMessage = function(input, callback) {
	this._req('patch', Endpoints.MESSAGES(input.channelID, input.messageID), generateMessage(input.message || '', input.embed), function(err, res) {
		handleResCB("Unable to edit message", err, res, callback);
	});
};

/**
 * Delete a posted message.
 * @arg {Object} input
 * @arg {Snowflake} input.channelID
 * @arg {Snowflake} input.messageID
 */
DCP.deleteMessage = function(input, callback) {
	this._req('delete', Endpoints.MESSAGES(input.channelID, input.messageID), function(err, res) {
		handleResCB("Unable to delete message", err, res, callback);
	});
};

/**
 * Delete a batch of messages.
 * @arg {Object} input
 * @arg {Snowflake} input.channelID
 * @arg {Array<Snowflake>} input.messageIDs - An Array of message IDs, with a maximum of 100 indexes.
 */
DCP.deleteMessages = function(input, callback) {
	this._req('post', Endpoints.BULK_DELETE(input.channelID), {messages: input.messageIDs.slice(0, 100)}, function(err, res) {
		handleResCB("Unable to delete messages", err, res, callback);
	});
};

/**
 * Pin a message to the channel.
 * @arg {Object} input
 * @arg {Snowflake} input.channelID
 * @arg {Snowflake} input.messageID
 */
DCP.pinMessage = function(input, callback) {
	this._req('put', Endpoints.PINNED_MESSAGES(input.channelID, input.messageID), function(err, res) {
		handleResCB("Unable to pin message", err, res, callback);
	});
};

/**
 * Get an array of pinned messages from a channel.
 * @arg {Object} input
 * @arg {Snowflake} input.channelID
 */
DCP.getPinnedMessages = function(input, callback) {
	this._req('get', Endpoints.PINNED_MESSAGES(input.channelID), function(err, res) {
		handleResCB("Unable to get pinned messages", err, res, callback);
	});
};

/**
 * Delete a pinned message from a channel.
 * @arg {Object} input
 * @arg {Snowflake} input.channelID
 * @arg {Snowflake} input.messageID
 */
DCP.deletePinnedMessage = function(input, callback) {
	this._req('delete', Endpoints.PINNED_MESSAGES(input.channelID, input.messageID), function(err, res) {
		handleResCB("Unable to delete pinned message", err, res, callback);
	});
};

/**
 * Send 'typing...' status to a channel
 * @arg {Snowflake} channelID
 */
DCP.simulateTyping = function(channelID, callback) {
	this._req('post', Endpoints.TYPING(channelID), function(err, res) {
		handleResCB("Unable to simulate typing", err, res, callback);
	});
};

/**
 * Replace Snowflakes with the names if applicable.
 * @arg {String} message - The message to fix.
 */
DCP.fixMessage = function(message) {
	var client = this;
	return message.replace(/<@&(\d*)>|<@!(\d*)>|<@(\d*)>|<#(\d*)>/g, function(match, RID, NID, UID, CID) {
		var k, i;
		if (UID || CID) {
			if (client.users[UID]) return "@" + client.users[UID].username;
			if (client.channels[CID]) return "#" + client.channels[CID].name;
		}
		if (RID || NID) {
			k = Object.keys(client.servers);
			for (i=0; i<k.length; i++) {
				if (client.servers[k[i]].roles[RID]) return "@" + client.servers[k[i]].roles[RID].name;
				if (client.servers[k[i]].members[NID]) return "@" + client.servers[k[i]].members[NID].nick;
			}
		}
	});
};

/**
 * Add an emoji reaction to a message.
 * @arg {Object} input
 * @arg {Snowflake} input.channelID
 * @arg {Snowflake} input.messageID
 * @arg {String} input.reaction - Either the emoji unicode or the emoji name:id/object.
 */
DCP.addReaction = function(input, callback) {
	var client = this;
	resolveID(client, input.channelID, function(channelID) {
		client._req('put', Endpoints.USER_REACTIONS(channelID, input.messageID, stringifyEmoji(input.reaction)), function(err, res) {
			handleResCB("Unable to add reaction", err, res, callback);
		});
	});
};

/**
 * Get an emoji reaction of a message.
 * @arg {Object} input
 * @arg {Snowflake} input.channelID
 * @arg {Snowflake} input.messageID
 * @arg {String} input.reaction - Either the emoji unicode or the emoji name:id/object.
 * @arg {String} [input.limit]
 */
DCP.getReaction = function(input, callback) {
	var qs = { limit: (typeof(input.limit) !== 'number' ? 100 : input.limit) };
	var client = this;
	resolveID(client, input.channelID, function(channelID) {
		client._req('get', Endpoints.MESSAGE_REACTIONS(channelID, input.messageID, stringifyEmoji(input.reaction)) + qstringify(qs), function(err, res) {
			handleResCB("Unable to get reaction", err, res, callback);
		});
	});
};

/**
 * Remove an emoji reaction from a message.
 * @arg {Object} input
 * @arg {Snowflake} input.channelID
 * @arg {Snowflake} input.messageID
 * @arg {Snowflake} [input.userID]
 * @arg {String} input.reaction - Either the emoji unicode or the emoji name:id/object.
 */
DCP.removeReaction = function(input, callback) {
	var client = this;
	resolveID(client, input.channelID, function(channelID) {
		client._req('delete', Endpoints.USER_REACTIONS(channelID, input.messageID, stringifyEmoji(input.reaction), input.userID), function(err, res) {
			handleResCB("Unable to remove reaction", err, res, callback);
		});
	});
};

/**
 * Remove all emoji reactions from a message.
 * @arg {Object} input
 * @arg {Snowflake} input.channelID
 * @arg {Snowflake} input.messageID
 */
DCP.removeAllReactions = function(input, callback) {
	var client = this;
	resolveID(client, input.channelID, function(channelID) {
		client._req('delete', Endpoints.MESSAGE_REACTIONS(channelID, input.messageID), function(err, res) {
			handleResCB("Unable to remove reactions", err, res, callback);
		});
	});
};

/* - DiscordClient - Methods - Server Management - */

/**
 * Remove a user from a server.
 * @arg {Object} input
 * @arg {Snowflake} input.serverID
 * @arg {Snowflake} input.userID
 */
DCP.kick = function(input, callback) {
	this._req('delete', Endpoints.MEMBERS(input.serverID, input.userID), function(err, res) {
		handleResCB("Could not kick user", err, res, callback);
	});
};

/**
 * Remove and ban a user from a server.
 * @arg {Object} input
 * @arg {Snowflake} input.serverID
 * @arg {Snowflake} input.userID
 * @arg {String} input.reason
 * @arg {Number} [input.lastDays] - Removes their messages up until this point, either 1 or 7 days.
 */
DCP.ban = function(input, callback) {
    var url = Endpoints.BANS(input.serverID, input.userID);
    var opts = {};

    if (input.lastDays) {
        input.lastDays = Number(input.lastDays);
        input.lastDays = Math.min(input.lastDays, 7);
        input.lastDays = Math.max(input.lastDays, 1);
        opts["delete-message-days"] = input.lastDays;
	}

    if (input.reason) opts.reason = input.reason;

    url += qstringify(opts);

    this._req('put', url, function(err, res) {
        handleResCB("Could not ban user", err, res, callback);
    });
}

/**
 * Unban a user from a server.
 * @arg {Object} input
 * @arg {Snowflake} input.serverID
 * @arg {Snowflake} input.userID
 */
DCP.unban = function(input, callback) {
	this._req('delete', Endpoints.BANS(input.serverID, input.userID), function(err, res) {
		handleResCB("Could not unban user", err, res, callback);
	});
};

/**
 * Move a user between voice channels.
 * @arg {Object} input
 * @arg {Snowflake} input.serverID
 * @arg {Snowflake} input.userID
 * @arg {Snowflake} input.channelID
 */
DCP.moveUserTo = function(input, callback) {
	this._req('patch', Endpoints.MEMBERS(input.serverID, input.userID), {channel_id: input.channelID}, function(err, res) {
		handleResCB("Could not move the user", err, res, callback);
	});
};

/**
 * Server-mute the user from speaking in all voice channels.
 * @arg {Object} input
 * @arg {Snowflake} input.serverID
 * @arg {Snowflake} input.userID
 */
DCP.mute = function(input, callback) {
	this._req('patch', Endpoints.MEMBERS(input.serverID, input.userID), {mute: true}, function(err, res) {
		handleResCB("Could not mute user", err, res, callback);
	});
};

/**
 * Remove the server-mute from a user.
 * @arg {Object} input
 * @arg {Snowflake} input.serverID
 * @arg {Snowflake} input.userID
 */
DCP.unmute = function(input, callback) {
	this._req('patch', Endpoints.MEMBERS(input.serverID, input.userID), {mute: false}, function(err, res) {
		handleResCB("Could not unmute user", err, res, callback);
	});
};

/**
 * Server-deafen a user.
 * @arg {Object} input
 * @arg {Snowflake} input.serverID
 * @arg {Snowflake} input.userID
 */
DCP.deafen = function(input, callback) {
	this._req('patch', Endpoints.MEMBERS(input.serverID, input.userID), {deaf: true}, function(err, res) {
		handleResCB("Could not deafen user", err, res, callback);
	});
};

/**
 * Remove the server-deafen from a user.
 * @arg {Object} input
 * @arg {Snowflake} input.serverID
 * @arg {Snowflake} input.userID
 */
DCP.undeafen = function(input, callback) {
	this._req('patch', Endpoints.MEMBERS(input.serverID, input.userID), {deaf: false}, function(err, res) {
		handleResCB("Could not undeafen user", err, res, callback);
	});
};

/*Bot server management actions*/

/**
 * Create a server [User only].
 * @arg {Object} input
 * @arg {String} input.name - The server's name
 * @arg {String} [input.region] - The server's region code, check the Gitbook documentation for all of them.
 * @arg {String<Base64>} [input.icon] - The last part of a Base64 Data URI. `fs.readFileSync('image.jpg', 'base64')` is enough.
 */
DCP.createServer = function(input, callback) {
	var payload, client = this;
	payload = {icon: null, name: null, region: null};
	for (var key in input) {
		if (Object.keys(payload).indexOf(key) < 0) continue;
		payload[key] = input[key];
	}
	if (input.icon) payload.icon = "data:image/jpg;base64," + input.icon;

	client._req('post', Endpoints.SERVERS(), payload, function(err, res) {
		try {
			client.servers[res.body.id] = {};
			copyKeys(res.body, client.servers[res.body.id]);
		} catch(e) {}
		handleResCB("Could not create server", err, res, callback);
	});
};

/**
 * Edit server information.
 * @arg {Object} input
 * @arg {Snowflake} input.serverID
 * @arg {String} [input.name]
 * @arg {String} [input.icon]
 * @arg {String} [input.region]
 * @arg {Snowflake} [input.afk_channel_id] - The ID of the voice channel to move a user to after the afk period.
 * @arg {Number} [input.afk_timeout] - Time in seconds until a user is moved to the afk channel. 60, 300, 900, 1800, or 3600.
 */
DCP.editServer = function(input, callback) {
	var payload, serverID = input.serverID, server, client = this;
	if (!client.servers[serverID]) return handleErrCB(("[editServer] Server " + serverID + " not found."), callback);

	server = client.servers[serverID];
	payload = {
		name: server.name,
		icon: server.icon,
		region: server.region,
		afk_channel_id: server.afk_channel_id,
		afk_timeout: server.afk_timeout
	};

	for (var key in input) {
		if (Object.keys(payload).indexOf(key) < 0) continue;
		if (key === 'afk_channel_id') {
			if (server.channels[input[key]] && server.channels[input[key]].type === 'voice') payload[key] = input[key];
			continue;
		}
		if (key === 'afk_timeout') {
			if ([60, 300, 900, 1800, 3600].indexOf(Number(input[key])) > -1) payload[key] = input[key];
			continue;
		}
		payload[key] = input[key];
	}
	if (input.icon) payload.icon = "data:image/jpg;base64," + input.icon;

	client._req('patch', Endpoints.SERVERS(input.serverID), payload, function(err, res) {
		handleResCB("Unable to edit server", err, res, callback);
	});
};

/**
 * Edit the widget information for a server.
 * @arg {Object} input
 * @arg {Snowflake} input.serverID - The ID of the server whose widget you want to edit.
 * @arg {Boolean} [input.enabled] - Whether or not you want the widget to be enabled.
 * @arg {Snowflake} [input.channelID] - [Important] The ID of the channel you want the instant invite to point to.
 */
DCP.editServerWidget = function(input, callback) {
	var client = this, payload, url = Endpoints.SERVERS(input.serverID) + "/embed";

	client._req('get', url, function(err, res) {
		if (err) return handleResCB("Unable to GET server widget settings. Can not edit without retrieving first.", err, res, callback);
		payload = {
			enabled: ('enabled' in input ? input.enabled : res.body.enabled),
			channel_id: ('channelID' in input ? input.channelID : res.body.channel_id)
		};
		client._req('patch', url, payload, function(err, res) {
			handleResCB("Unable to edit server widget", err, res, callback);
		});
	});
};

/**
 * [User Account] Add an emoji to a server
 * @arg {Object} input
 * @arg {Snowflake} input.serverID
 * @arg {String} input.name - The emoji's name
 * @arg {String<Base64>} input.image - The emoji's image data in Base64
 */
DCP.addServerEmoji = function(input, callback) {
	var payload = {
		name: input.name,
		image: "data:image/png;base64," + input.image
	};
	this._req('post', Endpoints.SERVER_EMOJIS(input.serverID), payload, function(err, res) {
		handleResCB("Unable to add emoji to the server", err, res, callback);
	});
}

/**
 * [User Account] Edit a server emoji data (name only, currently)
 * @arg {Object} input
 * @arg {Snowflake} input.serverID
 * @arg {Snowflake} input.emojiID - The emoji's ID
 * @arg {String} [input.name]
 * @arg {Array<Snowflake>} [input.roles] - An array of role IDs you want to limit the emoji's usage to
 */
DCP.editServerEmoji = function(input, callback) {
	var emoji, payload = {};
	if ( !this.servers[input.serverID] ) return handleErrCB(("[editServerEmoji] Server not available: " + input.serverID), callback);
	if ( !this.servers[input.serverID].emojis[input.emojiID]) return handleErrCB(("[editServerEmoji] Emoji not available: " + input.emojiID), callback);

	emoji = this.servers[input.serverID].emojis[input.emojiID];
	payload.name = input.name || emoji.name;
	payload.roles = input.roles || emoji.roles;

	this._req('patch', Endpoints.SERVER_EMOJIS(input.serverID, input.emojiID), payload, function(err, res) {
		handleResCB("[editServerEmoji] Could not edit server emoji", err, res, callback);
	});
};

/**
 * [User Account] Remove an emoji from a server
 * @arg {Object} input
 * @arg {Snowflake} input.serverID
 * @arg {Snowflake} input.emojiID
 */
DCP.deleteServerEmoji = function(input, callback) {
	this._req('delete', Endpoints.SERVER_EMOJIS(input.serverID, input.emojiID), function(err, res) {
		handleResCB("[deleteServerEmoji] Could not delete server emoji", err, res, callback);
	});
};

/**
 * Leave a server.
 * @arg {Snowflake} serverID
 */
DCP.leaveServer = function(serverID, callback) {
	this._req('delete', Endpoints.SERVERS_PERSONAL(serverID), function(err, res) {
		handleResCB("Could not leave server", err, res, callback);
	});
};

/**
 * Delete a server owned by the client.
 * @arg {Snowflake} serverID
 */
DCP.deleteServer = function(serverID, callback) {
	this._req('delete', Endpoints.SERVERS(serverID), function(err, res) {
		handleResCB("Could not delete server", err, res, callback);
	});
};

/**
 * Transfer ownership of a server to another user.
 * @arg {Object} input
 * @arg {Snowflake} input.serverID
 * @arg {Snowflake} input.userID
 */
DCP.transferOwnership = function(input, callback) {
	this._req('patch', Endpoints.SERVERS(input.serverID), {owner_id: input.userID}, function(err, res) {
		handleResCB("Could not transfer server ownership", err, res, callback);
	});
};

/**
 * (Used to) Accept an invite to a server [User Only]. Can no longer be used.
 * @deprecated
 */
DCP.acceptInvite = function(NUL, callback) {
	return handleErrCB("acceptInvite can no longer be used", callback);
};

/**
 * Generate an invite URL for a channel.
 * @arg {Object} input
 * @arg {Snowflake} input.channelID
 * @arg {Number} input.max_age
 * @arg {Number} input.max_uses
 * @arg {Boolean} input.temporary
 * @arg {Boolean} input.unique
 */
DCP.createInvite = function(input, callback) {
	var allowed = ["channelID", "max_age", "max_uses", "temporary", "unique"];
	var payload = {};

	allowed.forEach(function(name) {
		if (input[name]) payload[name] = input[name];
	});

	this._req('post', Endpoints.CHANNEL(payload.channelID) + "/invites", payload, function(err, res) {
		handleResCB('Unable to create invite', err, res, callback);
	});
};

/**
 * Delete an invite code.
 * @arg {String} inviteCode
 */
DCP.deleteInvite = function(inviteCode, callback) {
	this._req('delete', Endpoints.INVITES(inviteCode), function(err, res) {
		handleResCB('Unable to delete invite', err, res, callback);
	});
};

/**
 * Get information on an invite.
 * @arg {String} inviteCode
 */
DCP.queryInvite = function(inviteCode, callback) {
	this._req('get', Endpoints.INVITES(inviteCode), function(err, res) {
		handleResCB('Unable to get information about invite', err, res, callback);
	});
};

/**
 * Get all invites for a server.
 * @arg {Snowflake} serverID
 */
DCP.getServerInvites = function(serverID, callback) {
	this._req('get', Endpoints.SERVERS(serverID) + "/invites", function(err, res) {
		handleResCB('Unable to get invite list for server' + serverID, err, res, callback);
	});
};

/**
 * Get all invites for a channel.
 * @arg {Snowflake} channelID
 */
DCP.getChannelInvites = function(channelID, callback) {
	this._req('get', Endpoints.CHANNEL(channelID) + "/invites", function(err, res) {
		handleResCB('Unable to get invite list for channel' + channelID, err, res, callback);
	});
};

/**
 * Create a channel.
 * @arg {Object} input
 * @arg {Snowflake} input.serverID
 * @arg {String} input.name
 * @arg {String} [input.type] - 'text' or 'voice', defaults to 'text.
 * @arg {Snowflake} [input.parentID]
 */
DCP.createChannel = function(input, callback) {
	var client = this, payload = {
		name: input.name,
		type: (['text', 'voice'].indexOf(input.type) < 0) ? 'text' : input.type,
		parent_id: input.parentID
	};

	this._req('post', Endpoints.SERVERS(input.serverID) + "/channels", payload, function(err, res) {
		try {
			var serverID = res.body.guild_id;
			var channelID = res.body.id;

			client.channels[channelID] = new Channel( client, client.servers[serverID], res.body );
		} catch(e) {}
		handleResCB('Unable to create channel', err, res, callback);
	});
};

/**
 * Create a Direct Message channel.
 * @arg {Snowflake} userID
 */
DCP.createDMChannel = function(userID, callback) {
	var client = this;
	this._req('post', Endpoints.USER(client.id) + "/channels", {recipient_id: userID}, function(err, res) {
		if (!err && goodResponse(res)) client._uIDToDM[res.body.recipients[0].id] = res.body.id;
		handleResCB("Unable to create DM Channel", err, res, callback);
	});
};

/**
 * Delete a channel.
 * @arg {Snowflake} channelID
 */
DCP.deleteChannel = function(channelID, callback) {
	this._req('delete', Endpoints.CHANNEL(channelID), function(err, res) {
		handleResCB("Unable to delete channel", err, res, callback);
	});
};

/**
 * Edit a channel's information.
 * @arg {Object} input
 * @arg {Snowflake} input.channelID
 * @arg {String} [input.name]
 * @arg {String} [input.topic] - The topic of the channel.
 * @arg {Number} [input.bitrate] - [Voice Only] The bitrate for the channel.
 * @arg {Number} [input.position] - The channel's position on the list.
 * @arg {Number} [input.user_limit] - [Voice Only] Imposes a user limit on a voice channel.
 */
DCP.editChannelInfo = function(input, callback) {
	var channel, payload;

	try {
		channel = this.channels[input.channelID];
		payload = {
			name: channel.name,
			topic: channel.topic,
			bitrate: channel.bitrate,
			position: channel.position,
			user_limit: channel.user_limit,
			parent_id: (input.parentID === undefined ? channel.parent_id : input.parentID)
		};

		for (var key in input) {
			if (Object.keys(payload).indexOf(key) < 0) continue;
			if (+input[key]) {
				if (key === 'bitrate') {
					payload.bitrate = Math.min( Math.max( input.bitrate, 8000), 96000);
					continue;
				}
				if (key === 'user_limit') {
					payload.user_limit = Math.min( Math.max( input.user_limit, 0), 99);
					continue;
				}
			}
			payload[key] = input[key];
		}

		this._req('patch', Endpoints.CHANNEL(input.channelID), payload, function(err, res) {
			handleResCB("Unable to edit channel", err, res, callback);
		});
	} catch(e) {return handleErrCB(e, callback);}
};

/**
 * Edit (or creates) a permission override for a channel.
 * @arg {Object} input
 * @arg {Snowflake} input.channelID
 * @arg {Snowflake} [input.userID]
 * @arg {Snowflake} [input.roleID]
 * @arg {Array<Number>} input.allow - An array of permissions to allow. Discord.Permissions.XXXXXX.
 * @arg {Array<Number>} input.deny - An array of permissions to deny, same as above.
 * @arg {Array<Number>} input.default - An array of permissions that cancels out allowed and denied permissions.
 */
DCP.editChannelPermissions = function(input, callback) { //Will shrink this up later
	var payload, pType, ID, channel, permissions, allowed_values;
	if (!input.userID && !input.roleID) return handleErrCB("[editChannelPermissions] No userID or roleID provided", callback);
	if (!this.channels[input.channelID]) return handleErrCB(("[editChannelPermissions] No channel found for ID: " + input.channelID), callback);
	if (!input.allow && !input.deny && !input.default) return handleErrCB("[editChannelPermissions] No allow, deny or default array provided.", callback);

	pType = input.userID ? 'user' : 'role';
	ID = input[pType + "ID"];
	channel = this.channels[ input.channelID ];
	permissions = channel.permissions[pType][ID] || { allow: 0, deny: 0 };
	allowed_values = [0, 4, 28].concat(((channel.type === 'text' || channel.type === 0) ?
	[10, 11, 12, 13, 14, 15, 16, 17, 18] :
	[20, 21, 22, 23, 24, 25] ));

	//Take care of allow first
	if (type(input.allow) === 'array') {
		input.allow.forEach(function(perm) {
			if (allowed_values.indexOf(perm) < 0) return;
			if (hasPermission(perm, permissions.deny)) {
				permissions.deny = removePermission(perm, permissions.deny);
			}
			permissions.allow = givePermission(perm, permissions.allow);
		});
	}
	//Take care of deny second
	if (type(input.deny) === 'array') {
		input.deny.forEach(function(perm) {
			if (allowed_values.indexOf(perm) < 0) return;
			if (hasPermission(perm, permissions.allow)) {
				permissions.allow = removePermission(perm, permissions.allow);
			}
			permissions.deny = givePermission(perm, permissions.deny);
		});
	}
	//Take care of defaulting last
	if (type(input.default) === 'array') {
		input.default.forEach(function(perm) {
			if (allowed_values.indexOf(perm) < 0) return;
			permissions.allow = removePermission(perm, permissions.allow);
			permissions.deny = removePermission(perm, permissions.deny);
		});
	}

	payload = {
		type: (pType === 'user' ? 'member' : 'role'),
		id: ID,
		deny: permissions.deny,
		allow: permissions.allow
	};

	this._req('put', Endpoints.CHANNEL(input.channelID) + "/permissions/" + ID, payload, function(err, res) {
		handleResCB('Unable to edit permission', err, res, callback);
	});
};

/**
 * Delete a permission override for a channel.
 * @arg {Object} input
 * @arg {Snowflake} input.channelID
 * @arg {Snowflake} [input.userID]
 * @arg {Snowflake} [input.roleID]
 */
DCP.deleteChannelPermission = function(input, callback) {
	var payload, pType, ID;
	if (!input.userID && !input.roleID) return handleErrCB("[deleteChannelPermission] No userID or roleID provided", callback);
	if (!this.channels[input.channelID]) return handleErrCB(("[deleteChannelPermission] No channel found for ID: " + input.channelID), callback);

	pType = input.userID ? 'user' : 'role';
	ID = input[pType + "ID"];

	payload = {
		type: (pType === 'user' ? 'member' : 'role'),
		id: ID
	};

	this._req('delete', Endpoints.CHANNEL(input.channelID) + "/permissions/" + ID, payload, function(err, res) {
		handleResCB('Unable to delete permission', err, res, callback);
	});
};

/**
 * Create a role for a server.
 * @arg {Snowflake} serverID
 */
DCP.createRole = function(serverID, callback) {
	var client = this;
	this._req('post', Endpoints.ROLES(serverID), function(err, res) {
		try {
			client.servers[serverID].roles[res.body.id] = new Role(res.body);
		} catch(e) {}
		handleResCB("Unable to create role", err, res, callback);
	});
};

/**
 * Edit a role.
 * @arg {Object} input
 * @arg {Snowflake} input.serverID
 * @arg {Snowflake} input.roleID - The ID of the role.
 * @arg {String} [input.name]
 * @arg {String} [input.color] - A color value as a number. Recommend using Hex numbers, as they can map to HTML colors (0xF35353 === #F35353).
 * @arg {Boolean} [input.hoist] - Separates the users in this role from the normal online users.
 * @arg {Object} [input.permissions] - An Object containing the permission as a key, and `true` or `false` as its value. Read the Permissions doc.
 * @arg {Boolean} [input.mentionable] - Toggles if users can @Mention this role.
 */
DCP.editRole = function(input, callback) {
	var role, payload;
	try {
		role = new Role(this.servers[input.serverID].roles[input.roleID]);
		payload = {
			name: role.name,
			color: role.color,
			hoist: role.hoist,
			permissions: role._permissions,
			mentionable: role.mentionable,
			position: role.position
		};

		for (var key in input) {
			if (Object.keys(payload).indexOf(key) < 0) continue;
			if (key === 'permissions') {
				for (var perm in input[key]) {
					role[perm] = input[key][perm];
					payload.permissions = role._permissions;
				}
				continue;
			}
			if (key === 'color') {
				if (String(input[key])[0] === '#') payload.color = parseInt(String(input[key]).replace('#', '0x'), 16);
				if (Discord.Colors[input[key]]) payload.color = Discord.Colors[input[key]];
				if (type(input[key]) === 'number') payload.color = input[key];
				continue;
			}
			payload[key] = input[key];
		}
		this._req('patch', Endpoints.ROLES(input.serverID, input.roleID), payload, function(err, res) {
			handleResCB("Unable to edit role", err, res, callback);
		});
	} catch(e) {return handleErrCB(('[editRole] ' + e), callback);}
};

/**
 * Delete a role.
 * @arg {Object} input
 * @arg {Snowflake} input.serverID
 * @arg {Snowflake} input.roleID
 */
DCP.deleteRole = function(input, callback) {
	this._req('delete', Endpoints.ROLES(input.serverID, input.roleID), function(err, res) {
		handleResCB("Could not remove role", err, res, callback);
	});
};

/**
 * Add a user to a role.
 * @arg {Object} input
 * @arg {Snowflake} input.serverID
 * @arg {Snowflake} input.roleID
 * @arg {Snowflake} input.userID
 */
DCP.addToRole = function(input, callback) {
	this._req('put', Endpoints.MEMBER_ROLES(input.serverID, input.userID, input.roleID), function(err, res) {
		handleResCB("Could not add role", err, res, callback);
	});
};

/**
 * Remove a user from a role.
 * @arg {Object} input
 * @arg {Snowflake} input.serverID
 * @arg {Snowflake} input.roleID
 * @arg {Snowflake} input.userID
 */
DCP.removeFromRole = function(input, callback) {
	this._req('delete', Endpoints.MEMBER_ROLES(input.serverID, input.userID, input.roleID), function(err, res) {
		handleResCB("Could not remove role", err, res, callback);
	});
};

/**
 * Edit a user's nickname.
 * @arg {Object} input
 * @arg {Snowflake} input.serverID
 * @arg {Snowflake} input.userID
 * @arg {String} input.nick - The nickname you'd like displayed.
 */
DCP.editNickname = function(input, callback) {
	var payload = {nick: String( input.nick ? input.nick : "" )};
	var url = input.userID === this.id ?
		Endpoints.MEMBERS(input.serverID) + "/@me/nick" :
		Endpoints.MEMBERS(input.serverID, input.userID);

	this._req('patch', url, payload, function(err, res) {
		handleResCB("Could not change nickname", err, res, callback);
	});
};

/**
 * Edit a user's note.
 * @arg {Object} input
 * @arg {Snowflake} input.userID
 * @arg {String} input.note - The note content that you want to use.
 */
DCP.editNote = function(input, callback) {
	this._req('put', Endpoints.NOTE(input.userID), {note: input.note}, function(err, res) {
		handleResCB("Could not edit note", err, res, callback);
	});
};

/**
 * Retrieve a user object from Discord, the library already caches users, however.
 * @arg {Object} input
 * @arg {Snowflake} input.serverID
 * @arg {Snowflake} input.userID
 */
DCP.getMember = function(input, callback) {
	this._req('get', Endpoints.MEMBERS(input.serverID, input.userID), function(err, res) {
		handleResCB("Could not get member", err, res, callback);
	});
};

/**
 * Retrieve a group of user objects from Discord.
 * @arg {Object} input
 * @arg {Number} [input.limit] - The amount of users to pull, defaults to 50.
 * @arg {Snowflake} [input.after] - The offset using a user ID.
 */
DCP.getMembers = function(input, callback) {
	var qs = {};
	qs.limit = (typeof(input.limit) !== 'number' ? 50 : input.limit);
	if (input.after) qs.after = input.after;

	this._req('get', Endpoints.MEMBERS(input.serverID) + qstringify(qs), function(err, res) {
		handleResCB("Could not get members", err, res, callback);
	});
};

/**
 * Get the ban list from a server
 * @arg {Snowflake} serverID
 */
DCP.getBans = function(serverID, callback) {
	this._req('get', Endpoints.BANS(serverID), function(err, res) {
		handleResCB("Could not get ban list", err, res, callback);
	});
};

/**
 * Get all webhooks for a server
 * @arg {Snowflake} serverID
 */
DCP.getServerWebhooks = function(serverID, callback) {
	this._req('get', Endpoints.SERVER_WEBHOOKS(serverID), function(err, res) {
		handleResCB("Could not get server Webhooks", err, res, callback);
	});
};

/**
 * Get webhooks from a channel
 * @arg {Snowflake} channelID
 */
DCP.getChannelWebhooks = function(channelID, callback) {
	this._req('get', Endpoints.CHANNEL_WEBHOOKS(channelID), function(err, res) {
		handleResCB("Could not get channel Webhooks", err, res, callback);
	});
};

/**
 * Create a webhook for a server
 * @arg {Snowflake} serverID
 */
DCP.createWebhook = function(serverID, callback) {
	this._req('post', Endpoints.SERVER_WEBHOOKS(serverID), function(err, res) {
		handleResCB("Could not create a Webhook", err, res, callback);
	});
};

/**
 * Edit a webhook
 * @arg {Object} input
 * @arg {Snowflake} input.webhookID - The Webhook's ID
 * @arg {String} [input.name]
 * @arg {String<Base64>} [input.avatar]
 * @arg {String} [input.channelID]
 */
DCP.editWebhook = function(input, callback) {
	var client = this, payload = {}, allowed = ['avatar', 'name'];
	this._req('get', Endpoints.WEBHOOKS(input.webhookID), function(err, res) {
		if (err || !goodResponse(res)) return handleResCB("Couldn't get webhook, do you have permissions to access it?", err, res, callback);
		allowed.forEach(function(key) {
			payload[key] = (key in input ? input[key] : res.body[key]);
		});
		payload.channel_id = input.channelID || res.body.channel_id;

		client._req('patch', Endpoints.WEBHOOKS(input.webhookID), payload, function(err, res) {
			return handleResCB("Couldn't update webhook", err, res, callback);
		});
	});
};

/* --- Misc --- */

/**
 * Retrieves all offline (and online, if using a user account) users, fires the `allUsers` event when done.
 */
DCP.getAllUsers = function(callback) {
	var servers = Object.keys(this.servers).filter(function(s) {
			s = this.servers[s];
			if (s.members) return s.member_count !== Object.keys(s.members).length && (this.bot ? s.large : true);
		}, this);

	if (!servers[0]) {
		this.emit('allUsers');
		return handleErrCB("There are no users to be collected", callback);
	}
	if (!this.bot) send(this._ws, Payloads.ALL_USERS(this));

	return getOfflineUsers(this, servers, callback);
};

/* --- Functions --- */
function handleErrCB(err, callback) {
	if (!err) return false;
	return call(callback, [new Error(err)]);
}
function handleResCB(errMessage, err, res, callback) {
  // console.log(res.headers); // Chewey
	if (typeof(callback) !== 'function') return;
	res = res || {};
	if (!err && goodResponse(res)) return (callback(null, res.body), true);

	var e = new Error( err || errMessage );
	e.name = "ResponseError";
	e.statusCode = res.statusCode;
	e.statusMessage = res.statusMessage;
	e.response = res.body;
	return (callback(e), false);
}
function goodResponse(response) {
	return (response.statusCode / 100 | 0) === 2;
}
function stringifyError(response) {
	if (!response) return null;
	return response.statusCode + " " + response.statusMessage + "\n" + JSON.stringify(response.body);
}

/* - Functions - Messages - */
function sendMessage(client, to, message, callback) {
	resolveID(client, to, function(channelID) {
		client._req('post', Endpoints.MESSAGES(channelID), message, function(err, res) {
			handleResCB("Unable to send messages", err, res, callback);
		});
	});
}
function cacheMessage(cache, limit, channelID, message) {
	if (!cache[channelID]) cache[channelID] = {};
	if (limit === -1) return void(cache[channelID][message.id] = message);
	var k = Object.keys(cache[channelID]);
	if (k.length > limit) delete(cache[channelID][k[0]]);
	cache[channelID][message.id] = message;
}
function generateMessage(message, embed) {
	return {
		type: 0,
		content: String(message),
		nonce: Math.floor(Math.random() * Number.MAX_SAFE_INTEGER),
		embed: embed || {}
	};
}
function messageHeaders(client) {
	var r = {
		"accept": "*/*",
		"accept-language": "en-US;q=0.8",
	};
	if (isNode) {
		r["accept-encoding"] = "gzip, deflate";
		r.user_agent = "DiscordBot Dualcord (Put repo here)";
		r.dnt = 1;
	}
	try {
		r.authorization = (client.bot ? "Bot " : "") + client.internals.token;
	} catch(e) {}
	return r;
}
function simulateTyping(client, to, message, time, callback) {
	if (time <= 0) return sendMessage(client, to, message, callback);

	client.simulateTyping(to, function() {
		setTimeout(simulateTyping, Math.min(time, 5000), client, to, message, time - 5000, callback);
	});
}
function stringifyEmoji(emoji) {
	if (typeof emoji === 'object') // if (emoji.name && emoji.id)
		return emoji.name + ':' + emoji.id;
	if (emoji.indexOf(':') > -1)
		return emoji;
	return encodeURIComponent(decodeURIComponent(emoji));
}

/* - Functions - Utils */
function APIRequest(method, url) {
	var data, callback, opts, req, headers = messageHeaders(this);
	callback = ( typeof(arguments[2]) === 'function' ? arguments[2] : (data = arguments[2], arguments[3]) );

	if (isNode) {
		opts = URL.parse(url);
		opts.method = method;
		opts.headers = headers;

		req = requesters[opts.protocol.slice(0, -1)].request(opts, function(res) {
			var chunks = [];
			res.on('data', function(c) { chunks[chunks.length] = c; });
			res.once('end', function() {
				chunks = Buffer.concat(chunks);
				Zlib.gunzip(chunks, function(err, uc) {
					if (!err) uc = uc.toString();
					try { res.body = JSON.parse(uc || chunks); } catch(e) {}
					return callback(null, res);
				});
			});
		});
		if (type(data) === 'object' || method.toLowerCase() === 'get') req.setHeader("Content-Type", "application/json; charset=utf-8");
		if (data instanceof Multipart) req.setHeader("Content-Type", "multipart/form-data; boundary=" + data.boundary);
		if (data) req.write( data.result || JSON.stringify(data), data.result ? 'binary' : 'utf-8' );
		req.end();

		return req.once('error', function(e) { return callback(e.message); });
	}

	req = new XMLHttpRequest();
	req.open(method.toUpperCase(), url, true);
	for (var key in headers) {
		req.setRequestHeader(key, headers[key]);
	}
	req.onreadystatechange = function() {
		if (req.readyState == 4) {
			req.statusCode = req.status;
			req.statusMessage = req.statusText;
			try {req.body = JSON.parse(req.responseText);} catch (e) { return handleErrCB(e, callback); }
			callback(null, req);
		}
	};
	if (type(data) === 'object' || method.toLowerCase() === 'get') req.setRequestHeader("Content-Type", "application/json; charset=utf-8");
	if (data instanceof Multipart) req.setRequestHeader("Content-Type", "multipart/form-data; boundary=" + data.boundary);
	if (data) return req.send( data.result ? data.result : JSON.stringify(data) );
	req.send(null);
}
function send(ws, data) {
	if (ws && ws.readyState == 1) ws.send(JSON.stringify(data));
}
function copy(obj) {
	try {
		return JSON.parse( JSON.stringify( obj ) );
	} catch(e) {}
}
function copyKeys(from, to, omit) {
	if (!omit) omit = [];
	for (var key in from) {
		if (omit.indexOf(key) > -1) continue;
		to[key] = from[key];
	}
}
function applyProperties(object, properties) {
	properties.forEach(function(t) {
		Object.defineProperty(object, t[0], {
			configurable: true,
			writable: true,
			value: t[1]
		});
	}, object);
}
function type(v) {
	return Object.prototype.toString.call(v).match(/ (.*)]/)[1].toLowerCase();
}
function call(f, a) {
	if (typeof(f) != 'function') return;
	return f.apply(null, a);
}
function qstringify(obj) {
	//.map + .join is 7x slower!
	var i=0, s = "", k = Object.keys(obj);
	for (i;i<k.length;i++) {
		s += k[i] + "=" + obj[k[i]] + "&";
	}
	return "?" + s.slice(0, -1);
}
function emit(client, message) {
	if (!message.t) return;
	var t = message.t.split("_"), i = 1, args = [t[0].toLowerCase()];

	for (i; i<t.length; i++) {
		args[0] += t[i][0] + t[i].slice(1).toLowerCase();
	}
	for (i=2; i<arguments.length; i++) {
		args.push(arguments[i]);
	}
	args.push(message);
	client.emit.apply(client, args);
}
function decompressWSMessage(m, f) {
	f = f || {};
	return f.binary ? JSON.parse(Zlib.inflateSync(m).toString()) : JSON.parse(m);
}
function removeAllListeners(emitter, type) {
	if (!emitter) return;
	var e = emitter._evts, i, k, o, s, z;
	if (isNode) return type ? emitter.removeAllListeners(type) : emitter.removeAllListeners();

	if (type && e[type]) {
		for (i=0; i<e[type].length; i++) {
			emitter.removeListener(type, e[type][i]);
		}
	}

	if (!type) {
		k = Object.keys(e);
		for (o=0; o<k.length; o++) {
			s = e[ k[o] ];
			for (z=0; z<s.length; z++) {
				emitter.removeListener(k[o], s[z]);
			}
		}
	}
}
function colorFromRole(server, member) {
	return member.roles.reduce(function(array, ID) {
		var role = server.roles[ID];
		if (!role) return array;
		return role.position > array[0] && role.color ? [role.position, role.color] : array;
	}, [-1, null])[1];
}
function log(client, level_message) {
	var level, message;
	if (arguments.length === 2) {
		level = Discord.LogLevels.Info;
		message = level_message;
	} else {
		level = level_message;
		message = arguments[2];
	}
	return client.emit('log', level, message);
}

function givePermission(bit, permissions) {
	return permissions | (1 << bit);
}
function removePermission(bit, permissions) {
	return permissions & ~(1 << bit);
}
function hasPermission(bit, permissions) {
	return ((permissions >> bit) & 1) == 1;
}
//For the Getters and Setters
function getPerm(bit) {
	return function() {
		return ((this._permissions >> bit) & 1) == 1;
	};
}
function setPerm(bit) {
	return function(v) {
		if (v === true) return this._permissions |= (1 << (bit));
		if (v === false) return this._permissions &= ~(1 << bit);
	};
}

function getServerInfo(client, servArr) {
	for (var server=0; server<servArr.length; server++) {
		client.servers[servArr[server].id] = new Server(client, servArr[server]);
	}
}
function getDirectMessages(client, DMArray) {
	for (var DM=0; DM<DMArray.length; DM++) {
		client.directMessages[DMArray[DM].id] = new DMChannel(client._uIDToDM, DMArray[DM]);
	}
}
function resolveID(client, ID, callback) {
	/*Get channel from ServerID, ChannelID or UserID.
	Only really used for sendMessage and uploadFile.*/
	//Callback used instead of return because requesting seems necessary.

	if (client._uIDToDM[ID]) return callback(client._uIDToDM[ID]);
	//If it's a UserID, and it's in the UserID : ChannelID cache, use the found ChannelID

	//If the ID isn't in the UserID : ChannelID cache, let's try seeing if it belongs to a user.
	if (client.users[ID]) return client.createDMChannel(ID, function(err, res) {
		if (err) return console.log("Internal ID resolver error: " + JSON.stringify(err));
		callback(res.id);
	});

	return callback(ID); //Finally, the ID must not belong to a User, so send the message directly to it, as it must be a Channel's.
}
function resolveEvent(e) {
	return e.detail || ([e.data][0] ? [e.data] : [e.code]);
}

// Chewey
/* --- Initializing --- */
DCP.init= function(client, opts) {
	client.servers = {};
	client.channels = {};
	client.users = {};
	client.directMessages = {};
	client.internals = {
		oauth: {},
		version: CURRENT_VERSION,
		settings: {},
    token:client.token
	};
  delete client.token
  
	// client._connecting = true;

	// return getToken(client, opts);
}

function getToken(client, opts) {
	if (opts.token) return getGateway(client, opts.token);
	if (!isNode) {
		//Read from localStorage? Sounds like a bad idea, but I'll leave this here.
	}
}
function getGateway(client, token) {
	client.internals.token = token;

	return APIRequest('get', Endpoints.GATEWAY, function (err, res) {
		if (err || !goodResponse(res)) {
			client._connecting = false;
			return client.emit("disconnect", "Error GETing gateway:\n" + stringifyError(res), 0);
		}
		return startConnection(client, (res.body.url + "/?encoding=json&v=" + GATEWAY_VERSION));
	});
}

function getOfflineUsers(client, servArr, callback) {
	if (!servArr[0]) return call(callback);

	send(client._ws, Payloads.OFFLINE_USERS(servArr));
	return setTimeout( getOfflineUsers, 0, client, servArr, callback );
}
function checkForAllServers(client, ready, message) {
	var all = Object.keys(client.servers).every(function(s) {
		return !client.servers[s].unavailable;
	});
	if (all || ready[0]) return void(client._ready = true && client.emit('ready', message));
	return setTimeout(checkForAllServers, 0, client, ready, message);
}
function validateShard(shard) {
	return (
		type(shard)  === 'array' &&
		shard.length === 2       &&
		shard[0] <= shard[1]     &&
		shard[1] > 1
	) ? shard : null;
}



// Chewey
/* - Functions - Websocket Handling - */
DCP.handleWSMessage= function(data, flags) {
	// var message = decompressWSMessage(data, flags);
  var message = data;
	var _data = message.d;
	var client = this, user, server, member, old,
	userID, serverID, channelID, currentVCID,
	mute, deaf, self_mute, self_deaf;

	//Events
	client.emit('any', message);
	//TODO: Remove in v3
	client.emit('debug', message);
	switch (message.t) {
		case "READY":
			copyKeys(_data.user, client);
			client.internals.sessionID = _data.session_id;

			getServerInfo(client, _data.guilds);
			getDirectMessages(client, _data.private_channels);

			return (function() {
				if (client._ready) return;
				var ready = [false];
				setTimeout(function() { ready[0] = true; }, 3500);
				checkForAllServers(client, ready, message);
			})();
		case "MESSAGE_CREATE":
			client.emit('message', _data.author.username, _data.author.id, _data.channel_id, _data.content, message);
			emit(client, message, _data.author.username, _data.author.id, _data.channel_id, _data.content);
			return cacheMessage(client._messageCache, client._messageCacheLimit, _data.channel_id, _data);
		case "MESSAGE_UPDATE":
			try {
				emit(client, message, client._messageCache[_data.channel_id][_data.id], _data);
			} catch (e) { emit(client, message, undefined, _data); }
			return cacheMessage(client._messageCache, client._messageCacheLimit, _data.channel_id, _data);
		case "PRESENCE_UPDATE":
			if (!_data.guild_id) break;

			serverID = _data.guild_id;
			userID = _data.user.id;

			if (!client.users[userID]) client.users[userID] = new User(_data.user);

			user = client.users[userID];
			member = client.servers[serverID].members[userID] || {};

			copyKeys(_data.user, user);
			user.game = _data.game;

			copyKeys(_data, member, ['user', 'guild_id', 'game']);
			client.emit('presence', user.username, user.id, member.status, user.game, message);
			break;
		case "USER_UPDATE":
			copyKeys(_data, client);
			break;
		case "USER_SETTINGS_UPDATE":
			copyKeys(_data, client.internals);
			break;
		case "GUILD_CREATE":
			/*The lib will attempt to create the server using the response from the
			REST API, if the user using the lib creates the server. There are missing keys, however.
			So we still need this GUILD_CREATE event to fill in the blanks.
			If It's not our created server, then there will be no server with that ID in the cache,
			So go ahead and create one.*/
      console.log("Guild make fired in base");
			client.servers[_data.id] = new Server(client, _data);
			return emit(client, message, client.servers[_data.id]);
		case "GUILD_UPDATE":
			old = copy(client.servers[_data.id]);
			Server.update(client, _data);
			return emit(client, message, old, client.servers[_data.id]);
		case "GUILD_DELETE":
			emit(client, message, client.servers[_data.id]);
			return delete(client.servers[_data.id]);
		case "GUILD_MEMBER_ADD":
			client.users[_data.user.id] = new User(_data.user);
			client.servers[_data.guild_id].members[_data.user.id] = new Member(client, client.servers[_data.guild_id], _data);
			client.servers[_data.guild_id].member_count += 1;
			return emit(client, message, client.servers[_data.guild_id].members[_data.user.id]);
		case "GUILD_MEMBER_UPDATE":
			old = copy(client.servers[_data.guild_id].members[_data.user.id]);
			Member.update(client, client.servers[_data.guild_id], _data);
			return emit(client, message, old, client.servers[_data.guild_id].members[_data.user.id]);
		case "GUILD_MEMBER_REMOVE":
			if (_data.user && _data.user.id === client.id) return;
			client.servers[_data.guild_id].member_count -= 1;
			emit(client, message, client.servers[_data.guild_id].members[_data.user.id]);
			return delete(client.servers[_data.guild_id].members[_data.user.id]);
		case "GUILD_ROLE_CREATE":
			client.servers[_data.guild_id].roles[_data.role.id] = new Role(_data.role);
			return emit(client, message, client.servers[_data.guild_id].roles[_data.role.id]);
		case "GUILD_ROLE_UPDATE":
			server = client.servers[_data.guild_id];
			old = copy(server.roles[_data.role.id]);
			Role.update(server, _data);
			Object.keys(server.members).forEach(function(memberID) {
				var member = server.members[memberID];
				if ( member.roles.indexOf(_data.role.id) < 0 ) return;
				member.color = colorFromRole(server, member);
			});
			return emit(client, message, old, server.roles[_data.role.id]);
		case "GUILD_ROLE_DELETE":
			if (client.servers[_data.guild_id]){
				emit(client, message, client.servers[_data.guild_id].roles[_data.role_id]);
				return delete(client.servers[_data.guild_id].roles[_data.role_id]);
			}
			break;
		case "CHANNEL_CREATE":
			channelID = _data.id;

			if (_data.type == 1) {
				if (client.directMessages[channelID]) return;
				client.directMessages[channelID] = new DMChannel(client._uIDToDM, _data);
				return emit(client, message, client.directMessages[channelID]);
			}

			if (client.channels[channelID]) return;
			client.channels[channelID] = new Channel(client, client.servers[_data.guild_id], _data);
			return emit(client, message, client.channels[channelID]);
		case "CHANNEL_UPDATE":
			old = copy(client.channels[_data.id]);
			Channel.update(client, _data);
			return emit(client, message, old, client.channels[_data.id]);
		case "CHANNEL_DELETE":
			if (_data.type == 1) {
				emit(client, message, client.directMessages[_data.id]);
				delete(client.directMessages[_data.id]);
				return delete(client._uIDToDM[_data.recipients[0].id]);
			}
			Object.keys(client.servers[_data.guild_id].members).forEach(function(m) {
				if (client.servers[_data.guild_id].members[m].voice_channel_id == _data.id) {
					client.servers[_data.guild_id].members[m].voice_channel_id = null;
				}
			});
			emit(client, message, client.servers[_data.guild_id].channels[_data.id]);
			delete(client.servers[_data.guild_id].channels[_data.id]);
			return delete(client.channels[_data.id]);
		case "GUILD_EMOJIS_UPDATE":
			old = copy(client.servers[_data.guild_id].emojis);
			Emoji.update(client.servers[_data.guild_id], _data.emojis);
			return emit(client, message, old, client.servers[_data.guild_id].emojis);
		case "GUILD_MEMBERS_CHUNK":
			serverID = _data.guild_id;
			if (!client.servers[serverID].members) client.servers[serverID].members = {};

			_data.members.forEach(function(member) {
				var uID = member.user.id;
				var members = client.servers[serverID].members;
				if (members[uID]) return;
				if (!client.users[uID]) client.users[uID] = new User(member.user);
				members[uID] = new Member(client, client.servers[serverID], member);
			});
			var all = Object.keys(client.servers).every(function(server) {
				server = client.servers[server];
				return server.member_count === Object.keys(server.members).length;
			});

			if (all) return client.emit("allUsers");
			break;
		case "GUILD_SYNC":
			_data.members.forEach(function(member) {
				var uID = member.user.id;
				if (!client.users[uID]) client.users[uID] = new User(member.user);
				client.servers[_data.id].members[uID] = new Member(client, client.servers[_data.id], member);
			});

			_data.presences.forEach(function(presence) {
				var uID = presence.user.id;
				var members = client.servers[_data.id].members;
				if (!members[uID]) return void(new User(presence.user));
				delete(presence.user);
				copyKeys(presence, members[uID]);
			});
			client.servers[_data.id].large = _data.large;
			break;
	}
	return emit(client, message);
}


// Chewey
/* - DiscordClient - Classes - */
function Resource() {}
Object.defineProperty(Resource.prototype, "creationTime", {
	get: function() { return (+this.id / 4194304) + 1420070400000; },
	set: function() {}
});
[Server, Channel, DMChannel, User, Member, Role].forEach(function(p) {
	p.prototype = Object.create(Resource.prototype);
	Object.defineProperty(p.prototype, 'constructor', {value: p, enumerable: false});
});

function Server(client, data) {
	var server = this;
	//Accept everything now and trim what we don't need, manually. Any data left in is fine, any data left out could lead to a broken lib.
	copyKeys(data, this);
	this.large = this.large || this.member_count > LARGE_THRESHOLD;
	this.voiceSession = null;
	this.self_mute = !!this.self_mute;
	this.self_deaf = !!this.self_deaf;
	if (data.unavailable) return;

	//Objects so we can use direct property accessing without for loops
	this.channels = {};
	this.members = {};
	this.roles = {};
	this.emojis = {};

	//Copy the data into the objects using IDs as keys
	data.channels.forEach(function(channel) {
		client.channels[channel.id] = new Channel(client, server, channel);
	});
	data.roles.forEach(function(role) {
		server.roles[role.id] = new Role(role);
	});
	data.members.forEach(function(member) {
		client.users[member.user.id] = new User(member.user);
		server.members[member.user.id] = new Member(client, server, member);
	});
	data.presences.forEach(function(presence) {
		var id = presence.user.id;
		if (!client.users[id] || !server.members[id]) return;
		// delete(presence.user); //Chewey - why was this here originaly makes issue with djs load due to linking?

		client.users[id].game = presence.game;
		server.members[id].status = presence.status;
	});
	data.emojis.forEach(function(emoji) {
		server.emojis[emoji.id] = new Emoji(emoji);
	});
	data.voice_states.forEach(function(vs) {
		var cID = vs.channel_id;
		var uID = vs.user_id;
		if (!server.channels[cID] || !server.members[uID]) return;
		server.channels[cID].members[uID] = vs;
		server.members[uID].voice_channel_id = cID;
	});

	//Now we can get rid of any of the things we don't need anymore
	delete(this.voice_states);
	delete(this.presences);
}
function Channel(client, server, data) {
	var channel = this;
	this.members = {};
	this.permissions = { user: {}, role: {} };
	this.guild_id = server.id;
	copyKeys(data, this, ['permission_overwrites', 'emojis']);
	Object.defineProperty(server.channels, channel.id, {
		get: function() { return client.channels[channel.id]; },
		set: function(v) { client.channels[channel.id] = v; },
		enumerable: true,
		configurable: true
	});
	data.permission_overwrites.forEach(function(p) {
		var type = (p.type === 'member' ? 'user' : 'role');
		this.permissions[type][p.id] = {allow: p.allow, deny: p.deny};
	}, this);
}
function DMChannel(translator, data) {
	copyKeys(data, this);
	this.recipient = data.recipients[0];
	data.recipients.forEach(function(recipient) {
		translator[recipient.id] = data.id;
	});
}
function User(data) {
	copyKeys(data, this);
	this.bot = this.bot || false;
}
function Member(client, server, data) {
	copyKeys(data, this, ['user', 'joined_at',]);
	this.id = data.user.id;
	this.joined_at = Date.parse(data.joined_at);
	this.color = colorFromRole(server, this);
	['username', 'discriminator', 'bot', 'avatar', 'game'].forEach(function(k) {
		if (k in Member.prototype) return;

		Object.defineProperty(Member.prototype, k, {
			get: function() { return client.users[this.id][k]; },
			set: function(v) { client.users[this.id][k] = v; },
			enumerable: true,
		});
	});
}
function Role(data) {
	copyKeys(data, this, ['permissions']);
	//Use `permissions` from Discord, or `_permissions` if we're making it out of a cache.
	this._permissions = data._permissions || data.permissions;
}
function Emoji(data) {
	copyKeys(data, this);
}

function Multipart() {
	this.boundary =
		"NodeDualcord" + "-" + CURRENT_VERSION;
	this.result = "";
}
Multipart.prototype.append = function(data) {
	/* Header */
	var str = "\r\n--";
	str += this.boundary + "\r\n";
	str += 'Content-Disposition: form-data; name="' + data[0] + '"';
	if (data[2]) {
		str += '; filename="' + data[2] + '"\r\n';
		str += 'Content-Type: application/octet-stream';
	}
	/* Body */
	str += "\r\n\r\n" + ( data[1] instanceof Buffer ? data[1] : new Buffer(String(data[1]), 'utf-8') ).toString('binary');
	this.result += str;
};
Multipart.prototype.finalize = function() {
	this.result += "\r\n--" + this.boundary + "--";
};

Server.update = function(client, data) {
	if (!client.servers[data.id]) client.servers[data.id] = {}; // new Server(client, data)?
	for (var key in data) {
		if (key === 'roles') {
			data[key].forEach(function(r) {
				client.servers[data.id].roles[r.id] = new Role(r);
			});
			continue;
		}
		if (key === 'emojis') continue;
		client.servers[data.id][key] = data[key];
	}
};
Channel.update = function(client, data) {
	if (!client.channels[data.id]) client.channels[data.id] = {}; // new Channel(client, data)?
	for (var key in data) {
		if (key === 'permission_overwrites') {
			data[key].forEach(function(p) {
				var type = (p.type === 'member' ? 'user' : 'role');
				client.channels[data.id].permissions[type][p.id] = {
					allow: p.allow,
					deny: p.deny
				};
			});
			continue;
		}
		client.channels[data.id][key] = data[key];
	}
};
Member.update = function(client, server, data) {
	if (!server.members[data.user.id]) return server.members[data.user.id] = new Member(client, server, data);
	var member = server.members[data.user.id];
	copyKeys(data, member, ['user']);
	member.color = colorFromRole(server, member);
};
Role.update = function(server, data) {
	if (!server.roles[data.role.id]) server.roles[data.role.id] = {}; // new Role(data)?
	server.roles[data.role.id]._permissions = data.role.permissions;
	copyKeys(data.role, server.roles[data.role.id], ['permissions']);
};
Emoji.update = function(server, data) {
	server.emojis = {};
	data.forEach(function(emoji) {
		server.emojis[emoji.id] = new Emoji(emoji);
	});
}

Object.defineProperty(Role.prototype, "permission_values", {
	get: function() { return this; },
	set: function() {},
	enumerable: true
});
Object.defineProperty(User.prototype, 'avatarURL', {
	get: function() {
		if (!this.avatar) return null;
		var animated = this.avatar.indexOf("a_") > -1;
		return Discord.Endpoints.CDN + "/avatars/" + this.id + "/" + this.avatar + (animated ? ".gif" : ".webp");
	},
	set: function() {}
});

//Discord.OAuth;
Discord.version = CURRENT_VERSION;
Discord.Emitter = Emitter;
Discord.Codes = {};
Discord.Codes.WebSocket = {
	"0"   : "Gateway Error",
	"4000": "Unknown Error",
	"4001": "Unknown Opcode",
	"4002": "Decode Error",
	"4003": "Not Authenticated",
	"4004": "Authentication Failed",
	"4005": "Already Authenticated",
	"4006": "Session Not Valid",
	"4007": "Invalid Sequence Number",
	"4008": "Rate Limited",
	"4009": "Session Timeout",
	"4010": "Invalid Shard"
};
Discord.Colors = {
	DEFAULT: 0,
	AQUA: 1752220,
	GREEN: 3066993,
	BLUE: 3447003,
	PURPLE: 10181046,
	GOLD: 15844367,
	ORANGE: 15105570,
	RED: 15158332,
	GREY: 9807270,
	DARKER_GREY: 8359053,
	NAVY: 3426654,
	DARK_AQUA: 1146986,
	DARK_GREEN: 2067276,
	DARK_BLUE: 2123412,
	DARK_PURPLE: 7419530,
	DARK_GOLD: 12745742,
	DARK_ORANGE: 11027200,
	DARK_RED: 10038562,
	DARK_GREY: 9936031,
	LIGHT_GREY: 12370112,
	DARK_NAVY: 2899536
};
Discord.Permissions = {
	GENERAL_CREATE_INSTANT_INVITE: 0,
	GENERAL_KICK_MEMBERS: 1,
	GENERAL_BAN_MEMBERS: 2,
	GENERAL_ADMINISTRATOR: 3,
	GENERAL_MANAGE_CHANNELS: 4,
	GENERAL_MANAGE_GUILD: 5,
	GENERAL_AUDIT_LOG: 7,
	GENERAL_MANAGE_ROLES: 28,
	GENERAL_MANAGE_NICKNAMES: 27,
	GENERAL_CHANGE_NICKNAME: 26,
	GENERAL_MANAGE_WEBHOOKS: 29,
	GENERAL_MANAGE_EMOJIS: 30,

	TEXT_ADD_REACTIONS: 6,
	TEXT_READ_MESSAGES: 10,
	TEXT_SEND_MESSAGES: 11,
	TEXT_SEND_TTS_MESSAGE: 12,
	TEXT_MANAGE_MESSAGES: 13,
	TEXT_EMBED_LINKS: 14,
	TEXT_ATTACH_FILES: 15,
	TEXT_READ_MESSAGE_HISTORY: 16,
	TEXT_MENTION_EVERYONE: 17,
	TEXT_EXTERNAL_EMOJIS: 18,

	VOICE_CONNECT: 20,
	VOICE_SPEAK: 21,
	VOICE_MUTE_MEMBERS: 22,
	VOICE_DEAFEN_MEMBERS: 23,
	VOICE_MOVE_MEMBERS: 24,
	VOICE_USE_VAD: 25,
};
Discord.LogLevels = {
	Verbose: 0,
	Info: 1,
	Warn: 2,
	Error: 3
};

Object.keys(Discord.Permissions).forEach(function(pn) {
	Object.defineProperty(Role.prototype, pn, {
		get: getPerm( Discord.Permissions[pn] ),
		set: setPerm( Discord.Permissions[pn] ),
		enumerable: true
	});
});

/* Wrappers */
function Emitter() {
	var emt = this;
	if (isNode) {
		EE.call(this);
		if (this.prototype) return Util.inherits(this, EE);
		return new EE();
	}
	//Thank you, http://stackoverflow.com/a/24216547
	function _Emitter() {
		var eventTarget = document.createDocumentFragment();
		["addEventListener", "dispatchEvent", "removeEventListener"].forEach(function(method) {
			if (!this[method]) this[method] = eventTarget[method].bind(eventTarget);
		}, this);
	}
	//But I did the rest myself! D:<
	_Emitter.call(this);
	this._evts = {};
	this.on = function(eName, eFunc) {
		if (!emt._evts[eName]) emt._evts[eName] = [];
		emt._evts[eName].push(eOn);

		return this.addEventListener(eName, eOn);

		function eOn(e) {
			return eFunc.apply(null, resolveEvent(e));
		}
	};
	this.once = function(eName, eFunc) {
		if (!emt._evts[eName]) emt._evts[eName] = [];
		emt._evts[eName].push(eOnce);

		return this.addEventListener(eName, eOnce);

		function eOnce(e) {
			eFunc.apply(null, resolveEvent(e));
			return emt.removeListener(eName, eOnce);
		}
	};
	this.removeListener = function(eName, eFunc) {
		if (emt._evts[eName]) emt._evts[eName].splice(emt._evts[eName].lastIndexOf(eFunc), 1);
		return this.removeEventListener(eName, eFunc);
	};
	this.emit = function(eName) {
		return this.dispatchEvent( new CustomEvent(eName, {'detail': Array.prototype.slice.call(arguments, 1) }) );
	};
	return this;
}

function Websocket(url, opts) {
	if (isNode) return new (require('ws'))(url, opts);
	return Emitter.call(new WebSocket(url));
}

/* Endpoints */
(function () {
	var API = "https://discordapp.com/api";
	var CDN = "http://cdn.discordapp.com";
	var ME  = API + "/users/@me";
	Endpoints = Discord.Endpoints = {
		API: 		API,
		CDN: 		CDN,

		ME:			ME,
		NOTE:		function(userID) {
			return  ME + "/notes/" + userID;
		},
		LOGIN:		API + "/auth/login",
		OAUTH:		API + "/oauth2/applications/@me",
		GATEWAY:	API + "/gateway",
		SETTINGS: 	ME + "/settings",

		SERVERS: function(serverID) {
			return  API + "/guilds" + (serverID ? "/" + serverID : "");
		},
		SERVERS_PERSONAL: function(serverID) {
			return  this.ME + "/guilds" + (serverID ? "/" + serverID : ""); //Method to list personal servers?
		},
		SERVER_EMOJIS: function(serverID, emojiID) {
			return  this.SERVERS(serverID) + "/emojis" + (emojiID ? "/" + emojiID : "");
		},

		CHANNEL: function(channelID) {
			return  API + "/channels/" + channelID;
		},

		MEMBERS: function(serverID, userID) {
			return  this.SERVERS(serverID) + "/members" + (userID ? "/" + userID : "");
		},
		MEMBER_ROLES: function(serverID, userID, roleID) {
			return	this.MEMBERS(serverID, userID) + "/roles" + (roleID ? "/" + roleID : "");
		},

		USER: function(userID) {
			return  API + "/users/" + userID;
		},

		ROLES: function(serverID, roleID) {
			return  this.SERVERS(serverID) + "/roles" + (roleID ? "/" + roleID : "");
		},

		BANS: function(serverID, userID) {
			return  this.SERVERS(serverID) + "/bans" + (userID ? "/" + userID : "");
		},

		MESSAGES: function(channelID, messageID) {
			return  this.CHANNEL(channelID) + "/messages" + (messageID ? "/" + messageID : "");
		},
		PINNED_MESSAGES: function(channelID, messageID) {
			return  this.CHANNEL(channelID) + "/pins" + (messageID ? "/" + messageID : "");
		},

		MESSAGE_REACTIONS: function(channelID, messageID, reaction) {
			return  this.MESSAGES(channelID, messageID) + "/reactions" + ( reaction ? ("/" + reaction) : "" );
		},
		USER_REACTIONS: function(channelID, messageID, reaction, userID) {
		  	return  this.MESSAGE_REACTIONS(channelID, messageID, reaction) + '/' + ( (!userID || userID === this.id) ? '@me' : userID );
		},

		INVITES: function(inviteCode) {
			return  API + "/invite/" + inviteCode;
		},

		SERVER_WEBHOOKS: function(serverID) {
			return  this.SERVERS(serverID) + "/webhooks";
		},
		CHANNEL_WEBHOOKS: function(channelID) {
			return  this.CHANNEL(channelID) +"/webhooks";
		},

		WEBHOOKS: function(webhookID) {
			return  API + "/webhooks/" + webhookID;
		},

		BULK_DELETE: function(channelID) {
			return  this.CHANNEL(channelID) + "/messages/bulk-delete";
		},

		TYPING: function(channelID) {
			return  this.CHANNEL(channelID) + "/typing";
		}

	};
})();

/* Payloads */
(function() {
	Payloads = {
		IDENTIFY: function(client) {
			return {
				op: 2,
				d: {
					token: client.internals.token,
					v: GATEWAY_VERSION,
					compress: isNode && !!Zlib.inflateSync,
					large_threshold: LARGE_THRESHOLD,
					properties: {
						$os: isNode ? require('os').platform() : navigator.platform,
						$browser:"dualcord",
						$device:"dualcord",
						$referrer:"",
						$referring_domain:""
					}
				}
			};
		},
		RESUME: function(client) {
			return {
				op: 6,
				d: {
					seq: client.internals.s,
					token: client.internals.token,
					session_id: client.internals.sessionID
				}
			};
		},
		HEARTBEAT: function(client) {
			return {op: 1, d: client.internals.sequence};
		},
		ALL_USERS: function(client) {
			return {op: 12, d: Object.keys(client.servers)};
		},
		STATUS: function(input) {
			return {
				op: 3,
				d: {
					status: type(input.since) === 'number' ? 'idle' : input.status !== undefined ? input.status : null,
					afk: !!input.afk,
					since: type(input.since) === 'number' || input.status === 'idle' ? Date.now() : null,
					game: type(input.game) === 'object' ?
						{
							name: input.game.name ? String(input.game.name) : null,
							type: input.game.type ? Number(input.game.type) : 0,
							url: input.game.url ? String(input.game.url) : null
						} :
						null
				}
			};
		},
		UPDATE_VOICE: function(serverID, channelID, self_mute, self_deaf) {
			return {
				op: 4,
				d: {
					guild_id: serverID,
					channel_id: channelID,
					self_mute: self_mute,
					self_deaf: self_deaf
				}
			};
		},
		OFFLINE_USERS: function(array) {
			return {
				op: 8,
				d: {
					guild_id: array.splice(0, 50),
					query: "",
					limit: 0
				}
			};
		}
	}
})();

})(typeof exports === 'undefined'? this.Discord = {} : exports);