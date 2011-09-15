/*
 * client-details-test.js: Basic details about hooks for the hook.io module
 *
 * (C) 2011 Marak Squires, Charlie Robbins
 * MIT LICENCE
 *
 */
var vows = require('vows'),
    assert = require('assert'),
    Hook = require('../../lib/hookio').Hook,
    macros = require('../helpers/macros');

vows.describe('hook.io/discovery/client-details').addBatch({
  "When a Hook is listening on port 5011 with 2 client hooks": {
    topic : function() {
      var server = new Hook({name:'server', type: 'test'});
      var self = this;
      
      server.on('hook::listening', function() {
        var client1 = new Hook({ name: 'client1', type: 'test'});
        client1.start({"hook-port":5011});
        
        var client2 = new Hook({ name: 'another-client', type: 'another-test'});
        client2.on('hook::ready', function onReady () {
          self.callback(null, server, client1, client2)         // should add a timeout using addTimeout for handling errors ?
        });

        client2.start({"hook-port":5011});
      });
      server.start({"hook-port":5011});
    },/*
*/
    "and the *server hook* emits *hookDetails* asking for details": {
      "about *itself* by *name*": checkDetails(function (server, client, client2) {
          var self = this;
          server.emit('hookDetails', {name : server.name, callback: function onDetails (err, details) {
            self.callback(err, details, server, client, client2);
          }});
      }),
			"about *the 1st client* by *name*": checkDetails(function (server, client, client2) {
          var self = this;
					server.emit('hookDetails', {name : client.name, callback: function onDetails (err, details) {
            self.callback(err, details, server, client, client2);
          }});
      }),
			"about *the 2nd client* by *name*": checkDetails(function (server, client, client2) {
          var self = this;
          server.emit('hookDetails', {name : client2.name, callback: function onDetails (err, details) {
            self.callback(err, details, server, client, client2);
          }});
      })
    },
		"and a *client hook* emits *hookDetails* asking for details": {
      "about *itself* by *name*": checkDetails(function (server, client, client2) {
          var self = this;
          client.emit('hookDetails', {name : client.name, callback: function onDetails (err, details) {
            self.callback(err, details, server, client, client2);
          }});
      }),
      "about the *server* by *name*": checkDetails(function (server, client, client2) {
          var self = this;
          client.emit('hookDetails', {name : server.name, callback: function onDetails (err, details) {
            self.callback(err, details, server, client, client2);
          }});
      }),
      "about all hooks of type *test*": checkMultipleDetails(function (server, client, client2) {
          var self = this;
          client.emit('hookDetails', {type : 'test', callback: function onDetails (err, details) {
            self.callback(err, details, server, client, client2);
          }});
      }, ['server','client1']),
      "about all hooks on host *127.0.0.1*": checkMultipleDetails(function (server, client, client2) {
          var self = this;
          client.emit('hookDetails', {host : '127.0.0.1', callback: function onDetails (err, details) {
            self.callback(err, details, server, client, client2);
          }});
      }, ['server','client1', 'another-client']),
      "about all hooks on host *localhost*": checkMultipleDetails(function (server, client, client2) {
          var self = this;
          client.emit('hookDetails', {host : 'localhost', callback: function onDetails (err, details) {
            self.callback(err, details, server, client, client2);
          }});
      }, ['server','client1', 'another-client'])
    }
	}
}).export(module);


// macros

function checkDetails (topic) {
  return { 
    topic: topic,
    
    "the callback should get the instance details": function (err, details, server, client, client2) {
      assert.isObject(details);
    },
    "details should contain the name": function (err, details, server, client, client2) {
      assert.isString(details.name);
    },
    "details should contain the type": function (err, details, server, client, client2) {
      assert.isString(details.type);
    },
    "details should contain the host": function (err, details, server, client, client2) {
      assert.isString(details.remote.host);
    }
  };
}

function checkMultipleDetails (topic, targets) {
  targets = targets || [];

  return  {
    topic: topic,
    
    "the callback should get the instance details": function (err, multipleDetails, server, client, client2) {
      assert.isArray(multipleDetails);
    },
    "the details should contain the good number of hooks": function (err, multipleDetails, server, client, client2) {
      assert.strictEqual(multipleDetails.length, targets.length );
    },
    "details should contain the name": function (err, multipleDetails, server, client, client2) {
      multipleDetails.forEach(function(details) {
        assert.isString(details.name);
      });
    },
    "details should contain the type": function (err, multipleDetails, server, client, client2) {
      multipleDetails.forEach(function(details) {
        assert.isString(details.type);
      });
    },
    "details should contain the host": function (err, multipleDetails, server, client, client2) {
      multipleDetails.forEach(function(details) {
        assert.isString(details.remote.host);
      });
    }
  };
}
