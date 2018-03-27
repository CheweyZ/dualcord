#
Dualcord

Get the best of both discord.io and discord.js in a single lib. They run side by side, using only one connection to Discord. It takes the resources of just one bot even though you get the benefits of both libraries.

How do you use it? Well, in any function, you can use either lib's format and functions. For example, if you don't like how you access a server in d.js, then you can just reference it in d.io format even from within a d.js function. Or if you don't like how d.io manages voice connections, you can use d.js's voice methods, even when all the rest of your code is written in d.io.

```js
var discordClient = require('dualcord')
var client = new discordClient()
client.login({
  token: "Not stealing me token"
})
var dio = client.dioClient()
var djs = client.djsClient()

djs.on('ready', () => {
  console.log("Im Online");
})

dio.on('message', (user, userID, channelID, message, event) => {
  if (message == "Hello") {
    dio.sendMessage({
      to: channelID,
      message: "Hi to you to"
    })
  }
})

djs.on('message',(msg)=>{
  if (msg.content=='ping'){
    dio.sendMessage({to:msg.channel.id,message:`Pong ${djs.ping}`})
  }
})
```

The example above demonstrates how to use each library with dualcord. For documentation on the individual libraries, check out their pages. In the example, dio is the discord.io client so you interact with it same as normal. The same goes for djs which is discord.js.



Documentation

[discord.js](https://discord.js.org)

[discord.io](https://izy521.gitbooks.io/discord-io/content/) or for raw functions in discord.io checkout [https://izy521.github.io/discord.io-docs/](https://izy521.github.io/discord.io-docs/)



> Disclaimer
> discord.io does not support voice connections when using dualcord. 
> If you wish to use voice functionality, you must use discord.js for that.
> discord.io uses Woor's fork of the official library of discord.io, since the official version no longer works.



