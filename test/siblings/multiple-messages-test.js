/*
 * multiple-messages-test.js: Test the ability to work with multiple hook and rather important message passing
 *                            to demonstrate some heavier network usage.
 *
 *                            This test suite init and start a server hook with a predefined number
 *                            of clients, emiting back and fourth the content of browser/hook.js (150kb).
 *
 * (C) 2011 Marak Squires, Charlie Robbins
 * MIT LICENCE
 *
 */

var vows = require('vows'),
    assert = require('assert'),
    fs = require('fs'),
    path = require('path'),
    Hook = require('../../lib/hookio').Hook,
    macros = require('../helpers/macros'),
    EventEmitter = require('events').EventEmitter;


// The local fixture, map to browser/hook.js
var fixture = fs.readFileSync(path.join(__dirname, '../../browser/hook.js')).toString();

// create a local macro
// TODO: see if it's better to put this in helpers/macros
var macro = function(event, port){

  var context = {
    topic: function(server, data) {
      var messager = new Hook({ name: 'simple-client-messager' });

      server.once('*::' + event, function(data) {
        server.emit('response.' + event, data);
      });

      messager.once('*::response.' + event, this.callback.bind(server, null));

      messager.connect({ 'hook-port': port });
      messager.once('hook::connected', function () {
        messager.emit(event, {content: fixture});
      });
    }
  };

  context["the *::" + event + " should be fired correctly"] = function(data) {
    assert.equal(data.content, fixture);
  };

  return context;
};

// creates a context with a preder 
macro.multipleSubscriber = function(prefix, count) {
  var context = {},
      test = count;

  context["to listen with wildcard mapping"] = {
    topic: function() {
      var listener = new Hook({ name: 'simple-listener' }),
          self = this,
          length = count - 1;

      listener.connect({ 'hook-port': 5002 });
      listener.on('*::test::*::*', function log () {
        if(--length === 0) self.callback();
      });
    },

    "should be able to listen each of the emitted event": function() {
      assert.ok(true);
    }
  };

  while(--test) {
    context["to emit *::" + prefix + test] = macro(prefix + test, 5002);
  }

  return context;
};


// Start the batch with a with a predefined number of cycles
vows.describe('hook.io/siblings/multiple-message').addBatch({
  "When a hook is listening on 5050": macros.assertListen('simple-server', 5002, {
    "and another hooks connects": macro.multipleSubscriber('test::foo::', 10)
  })
}).export(module);

