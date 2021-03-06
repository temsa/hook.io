/*
 * Creates a helloworld hook, then spawns three helloworld children
 */

var Hook = require('../lib/hookio').Hook;

var pingPongModule = require('../test/fixtures/pingPongModule.js');

var hook1 = new Hook({ 
  name: "server-hook",
});

var hook2 = new Hook({ 
  name: "callback-hook",
});


hook1.on('*::hello', function(data, callback){
  //
  // this.callback is the callback for this event,
  // should it exist
  //
  callback(null, data);
})

hook1.on('hook::ready', function(){
  
  hook2.start();
  
  hook2.on('hook::ready', function(){

    //
    // Event with data
    // event, data, callback
    //
    hook2.emit('hello', 'data1', function(err, data){
      console.log('callback1 ', err, data);
    });

    //
    // Event with data
    // event, data, callback
    //
    hook2.emit('hello', {"foo":"bar"}, function(err, data){
      console.log('callback2 ', err, data);
    });

    //
    // Event with no data
    // event, callback
    //
    hook2.emit('hello', function(err, data){
      console.log('callback3 ', err, data);
    });

  });
  
});

hook1.start();