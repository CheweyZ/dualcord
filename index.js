const { Client , Constants} = require('discord.js');
const discordIO=require('./discordio.js')

var duelCord = (function(){
  var dio, djs;
  var login = (options)=>{
    dio = new discordIO.Client({
      token:options.token,
      autorun:false
    });
    djs = new Client({autoReconnect:options.autoReconnect});
    djs.on('raw',(raw)=>{
      dio.handleWSMessage(raw)
    })
    djs.on('ready',() => {
    })
    djs.on('disconnected',(event)=>{
      dio.emit('disconnect',Constants.WSCodes[event.code],event.code)
    })
    dio.init(dio)
    djs.login(options.token);
    
  }
  var dioClient= function(){
    return dio
  }
  var djsClient= function(){
    return djs
  }
  return {login,dioClient,djsClient}
})

module.exports=duelCord