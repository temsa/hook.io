/*
 * hook.js: Core hook object responsible for managing dnode-based IPC.
 *
 * (C) 2011 Nodejitsu Inc.
 * MIT LICENCE
 *
 */

var async  = require('async'),
    dnode  = require('dnode'),
    util   = require('util'),
    colors = require('colors'),
    nconf  = require('nconf'),
    npm    = require('./npm-api'),
    path   = require('path'),
    dns = require('dns'),
    EventEmitter = require('eventemitter2').EventEmitter2,
    hookio = require('../hookio'),
    argv   = hookio.cli.argv;

var reserved = ['hook', 'connection', 'children', 'error', 'client'],
    DELIMITER = '::';

//
// TODO: Switch transports require to lazy loaded based on,
// /transports/ directory files
//
var _transports = {
  "couchdb": require('./transports/couchdb')
};

//
// ### function Hook (options)
// #### @options {Object} Options for this instance.
// Constructor function for the Hook object responsible for managing
// dnode based IPC.
//
var Hook = exports.Hook = function (options) {
  var self = this;

  //
  // TODO: We should make events Arrays and there should be options
  // which can be passed to the `EventEmitter2` constructor function. 
  //
  EventEmitter.call(this, { delimiter: DELIMITER, wildcard: true });
  options = options || {};

  //
  // Each hook get's their own config.json file managed
  // by an instance of the `nconf.Provider`.
  //
  // Remark: This configuration path needs to load from a
  // default configuration file and then write to a custom
  // configuration file based on the hook `type/name` combo.
  //

  this.config = new nconf.Provider();
  this.config.use('file', { file: './config.json' });
  this.config.load();

  //
  // Load the nconf store into memory
  //
  var config = this.config.store.store;

  //
  // Iterate over nconf store and copy key values,
  // to Hook
  //
  Object.keys(config).forEach(function (o) {
    self[o] = config[o];
  });

  //
  // Iterate over argv and copy key values,
  // to Hook ( overwriting duplicate keys from config )
  //
  Object.keys(argv).forEach(function (o) {
    var reserved = ["hook-port", "hook-host"];
    if(reserved.indexOf(o) === -1){
      self[o] = argv[o];
    }
  });

  //
  // Iterate over options and copy key values,
  // to Hook ( overwriting duplicate keys from config )
  //
  Object.keys(options).forEach(function (o) {
    self[o] = options[o];
  });

  //
  // Setup some intelligent defaults.
  //
  this.id        = 0;
  this._names    = {};
  this.defaults  = {};
  this.children  = {};
  this.listening = false;
  this.connected = false;

  //
  // The covention of self.foo = self.foo || options.foo,
  // is being used so other classes can extend the Hook class
  //
  this.name = this.name || options.name || argv['hook-name'];
  this.type = this.type || options.type || argv['hook-type'] || this.name || 'no-hook';

  //
  // All servers and clients will listen and connect port 5000 by default
  //
  this.debug = options.debug === true || argv.debug === true;
  this.defaults['hook-port']   = options['hook-port']   || argv['hook-port']   || 5000;
  this.defaults['hook-host']   = options['hook-host']   || argv['hook-host']   || 'localhost';
  this.defaults['hook-socket'] = options['hook-socket'] || argv['hook-socket'] || null;

  this.npm = npm;

  // 
  // Each hook get's their own config.json file managed
  // by an instance of the `nconf.Provider`.

  //
  // Assign message transports for this hook
  //
  this.transports = this.transports || [];

  //
  // Remark: This is a hack for passing arrays of objects as strings,
  // through argv...fix this in optimist
  //
  if (typeof this.transports === 'string') {
    try {
      this.transports = JSON.parse(this.transports);
    } catch (err) {
     console.log('warn: bad transport parse', err.message);
    }
  }

  this.on('*::getEvents', function(){
    self.emit('gotEvents', self.getEvents());
    //
    // TODO: Add callback stuff here
    //
  });

  this.on('*::install', function(hook, callback){
    self.emit('npm::installing', hook);
    npm.install(hook, function(err, result){
      if(err){
        return self.emit('npm::install::error', err);
      }
      self.emit('npm::installed', result);
    });
  });

  //
  // If we have been passed in an eventMap,
  // map each event to the Hook
  //
  if (typeof options.eventMap === 'object') {
    self.mapEvents(options.eventMap);
  }
  
  
  var self = this;

  //
  // Performs a query on the hook to get details about other hooks.
  // takes an object as first parameter, which should look like:
  //   {name:'name-of-the-targetted-hook'}
  // or
  //   {type:'type-of-the-targetted-hook'}
  // or
  //   {host:'hostname-hosting-some-hook-or-its-IP'}
  //
  // the result can be received either as:
  // - a callback(error, details) if callback is provided as a standard callback
  //
  //    * error parameter will be returned if result is empty
  //    * details will be a String (or undefined) if we have queried by name
  //
  // - a query::out({query: originalQuery, details: arrayOfDetails}) event
  //   if callback is not defined.
  //
  //    * details is then always an Array of details, and if nothing is available
  //        for the passed query, Array is just empty.
  //    * query contains the original query, in order for your hook to check
  //        it's one similar to what it was looking for, or not.
  //
  // Each details provided is of the form :
  // {
  //   name: 'hook-name',
  //   type:'hook-type',
  //   remote:{ host:'ip address', port:99999/*port number*/}
  // }
  //
  function query(params, callback) {

      params = params || {};
      var name = params.name,
          type = params.type,
          host = params.host;

      if (!self.server) {
        return;
      }

      if(typeof callback !== "function") {
        callback = function(err, details) {
          if(!Array.isArray(details)) {
            details = [details];
          }
          return self.emit("query::out", {query: params, details: details})};
      }
      if(name) {
        if (self._names[name]) {
          //console.log(callback);
          callback(null, self._names[name]);
        }
        else {
          callback(new Error("No hook named "+name+" is connected (anymore?)"));
        }
      } else if (type) {
        var details = Object.keys(self._names)
          .map(function(key){ if(self._names[key].type === type) return self._names[key]; })
          .filter(function(detail){return detail});

        if (details.length>0) {
          callback(null, details);
        } else {
          callback(new Error("No hook of type "+type+" is connected (anymore?)"),[]);
        }

      } else if(host) {     
          self.toIPs(host, function onIP(err, hosts) {
            var details = Object.keys(self._names).map(function getHooks(key) {
              if( hosts.some( function hasHost (host){return host === self._names[key].remote.host} ) )
                return self._names[key];
            }).filter(function(detail){return detail});
              
            if(details.length>0)
              callback(null, details);
            else
              callback(new Error("No hook for host "+host+" is connected (anymore?)"),[]);
          });
      }
  }
  this.on("*::query", query);
  this.on("query", query);

};

//
// Inherit from `EventEmitter2`.
//
util.inherits(Hook, EventEmitter);

//
// ### function emit (event, data, local)
// #### @event {string} Event name to emit / broadcast
// #### @data {**} Data to associate with the event
// #### @broadcast {boolean} Value indicating if this event is local (i.e. should not be broadcast)
// Calls of the listeners on `event` for this instance and also broadcasts
// it to the parent (i.e. `this.remote`) if it exists and `local` is not set.  
//
// TODO: Support more than one data argument in `.emit()`
//
Hook.prototype.emit = function (event, data, callback, broadcast) {
  if (event === 'newListener') {
    return EventEmitter.prototype.emit.apply(this, arguments);
  }

  var parts = event.split(DELIMITER);

  //
  // Curry arguments to support multiple styles,
  // of callback passing.
  //
  
  if(typeof data === 'function') {
    callback = data;
    data = null;
  }

  if(typeof callback !== 'function') {
    broadcast = callback || false;
    callback = new Function();
  }

  //
  // Log all emitted events
  //
  this.log(this, event, data);

  if (broadcast !== true && this.remote && reserved.indexOf(parts[0]) === -1) {
    //
    // If this call to emit has not been forced local, this instance has a 
    // remote (i.e. parent) connection and it is not a reserved event
    // (i.e. local-only: 'hook::*', 'connection::*' or 'children::*') 
    // the broadcast it back to the parent
    //

    this.transports.forEach(function(transport) {
      _transports[transport.type].message(transport.options, this.name + DELIMITER + event, data, callback);
    });

    this.remote.message(this.name + DELIMITER + event, data, callback);
  }

  return EventEmitter.prototype.emit.apply(this, arguments);
}

//
// ### function start (options, callback) 
// #### @options {Object} Options to use when starting this hook.
// #### @callback {function} Continuation to respond to when complete
// Attempts to spawn the hook server for this instance. If a server already
// exists for those `options` then attempt to connect to that server.
//
Hook.prototype.start = function (options, callback) {  
  var self = this;

  if (!callback && typeof options === 'function') {
    callback = options;
    options = {};
  }

  //
  // Remark: (indexzero) `.start()` should do more lookup
  // table auto-discovery before calling `.listen()` but
  // that's a work in progress
  //
  this.listen(options, function (err) {
    if (err) {
      if (err.code == 'EADDRINUSE') {
        self.emit('error::bind', self['hook-port']);
        delete self.server; //not useful anymore, saves memory and trouble finding server
        return self.connect(options, callback);
      }
      self.emit('error::unknown', err);
    }
    
    if (callback) {
      callback.apply(null, arguments);
    }
  });
  
};

//
// ### function listen (options, callback) 
// #### @options {Object} Options to use when listening for this hook server.
// #### @callback {function} Continuation to respond to when complete
// Attempts to spawn the hook server for this instance. 
//
Hook.prototype.listen = function (options, callback) { 
  if (!callback && typeof options === 'function') {
    callback = options;
    options = {};
  }
  
  options = options || {};
  
  this.listening    = true;
  this['hook-port'] = options['hook-port'] || this.defaults['hook-port'];
  this['hook-host'] = options['hook-host'] || this.defaults['hook-host'];
  
  if (options.server) {
    this['hook-port'] = options.server;
  }
  
  var self = this;

  //registers the server in the register
  self.toIPs(self['hook-host'], function onResolve(err, hosts){
    var host = hosts[0]; // TODO handle a list of host ?
    
    if(err)
      throw err;
    // Registers itself in the hook registry using an IP for quick resolution
    self._names[self.name] = {
      name: self.name,
      type: self.type,
      remote: {
        port: self['hook-port'],
        host: host
      }
    }
    
    self.server = dnode(function (client, conn) {

      //removes the hook from the register
      conn.on('end', function () {
        for(name in self._names) {
          if(self._names[name].session === conn.id) {
            delete self._names[name];
            break;
          }
        }
      });
      
      this.report = function (name, type, reported) {
        //
        // ### function checkName (name, type, id)
        // #### @name {String} Name of hook to check
        // Recurisively checks hook's name until it
        // finds an available name for hook.
        //
        function checkName (name, id) {

          var _name;

          if (typeof id !== 'undefined') {
            _name = name + '-' + id;
            id++;
          } else {
            id = 0;
            _name = name;
          }

          if (Object.keys(self._names).indexOf(_name) === -1 && self.name !== _name) {
            self._names[_name] = {name: _name};
            return _name;
          } 

          return checkName(name, id);
        }
        
        //
        // Update the name on the client accordingly
        //
        client.name = checkName(name);
        self._names[client.name].type = type;
        self._names[client.name].session = conn.id;//self.server.proto.sessions[conn.id];
        self._names[client.name].remote = {
          port: self.server.proto.sessions[conn.id].stream.remotePort,
          host: self.server.proto.sessions[conn.id].stream.remoteAddress
        }

        client.type = type;    
    
        self.emit('client::connected', client.name);
        reported(client.name);
      };

      this.message = function (event, data, callback) {
        self.emit(event, data, callback);
      };

      //
      // On incoming events to the server,
      // send those events as messages to all clients
      //
      self.onAny(function (data, remote) {
        var parts = this.event.split(DELIMITER),
            event = !remote ? [self.name, this.event].join(DELIMITER) : this.event;
                  
        //
        // Only broadcast if the client has a message function, it is not a reserved 
        // (i.e. local-only: 'hook::*', 'connection::*' or 'children::*') and 
        // the event was not broadcast by the client itself (e.g. no circular transmissions)
        //
        if (client.message && reserved.indexOf(parts[0]) === -1 && parts[0] !== client.name) {

          //
          //  Remark: The current approach for minimizing excess messaging is,
          //  to send a message to every client first, to determine if the actual,
          //  message should get sent.
          //
          //
          //  TODO: This is a good start, but ultimately we need to reduce the,
          //  total amount of network hops ( period ). We need to store the available event
          //  table in memory, and then intelligently know when to update it.
          //
          //  In most cases, we can just store this on Hook connection, and never update it
          //

          //
          // Remark: Before sending any message, request client for registered events
          // and send message with data only if the client is interrested in this event
          //
          client.hasEvent(parts, remote, function(err, send) {
            if (!send) {
              //
              // Remark: We may want to do something with this event.
              //
              //         self.emit('hook::noevent', event);
              return;
            }

            self.transports.forEach(function(transport) {
              _transports[transport.type].message(transport.options, event, data, callback);
            });

            client.message(event, data, callback);
          });

        }
      });
    });

    self.server.on('connection', function (conn) {
      self.emit('connection::open', conn);
    });

    self.server.on('ready', function () {
      self.emit('hook::listening', self['hook-port']);
      self.emit('hook::ready', self['hook-port']);
    
      if (callback) {
        callback();
      }
    });


    //
    // Remark: Hook discovery could be improved, but needs the semantic
    // and cardinality to be better defined.
    //
    try {
      self.server.listen(self['hook-port']);
    }
    catch (ex) {
      if (callback) {
        return callback(ex);
      }
      
      self.emit('error', ex);
    }
  });
};

//
// ### function connect (options, callback) 
// #### @options {Object} Options to use when starting this hook.
// #### @callback {function} Continuation to respond to when complete
// Attempt to connect to a hook server using the specified `options`.
//
Hook.prototype.connect = function (options, callback) {
  if (!callback && typeof options === 'function') {
    callback = options;
    options = {};
  }
  
  options = options || {};

  this['hook-port'] = this['hook-port'] || options['hook-port'] || this.defaults['hook-port'];
  this['hook-host'] = this['hook-host'] || options['hook-host'] || this.defaults['hook-host'];

  var self = this, 
      client;

  client = dnode({
    message: function (event, data, callback) {
      self.emit(event, data, true, callback);
    },

    hasEvent: function(parts, remote, callback) {
      // begin the walk from * namespace
      var map = self.getEvents(),
          root = remote ? map : map['*'];

      // begin the walk from * namespace and handle remote case,
      // where we need to search the first part as if
      // it was a `*`
      parts[0] = remote ? '*' : parts[0];

      // walk the event map to find any handler
      parts.forEach(function(part, i) {
        // If the event emitted is '*' at this part
        // or there is a concrete match
        var wildcard = root && root['*'];

        root = root ? (root[part] || null) :  root;

        // at this point, if the root is set to null, assign wildcard value if there is any
        root = root ? root : wildcard;
      });

      // if root is falsy (null), then assume there's no listener for this specific
      // client, prevent message sending
      callback(null, !!root);
    }
  });

  //
  // Remark: Create dnode connection options based 
  // on (this) Hook configuration
  //
  var dnodeOptions = this._dnodeOptions();

  client.connect(dnodeOptions, function (remote, conn) {
    self.conn      = conn;
    self.remote    = remote;
    self.connected = true;

    conn.on('end', function () {
      self.emit('connection::end');
    });

    remote.report(self.name, self.type, function (newName, newID) {
      self.name = newName;
      self.id   = newID;

      self.emit('hook::connected', self['hook-port']);
      self.emit('hook::ready', self['hook-port']);
      
      if (callback) {
        callback();
      }
    });
  });
};

//
// ### function spawn (hooks, callback)
// #### @hooks {string|Array|Object} Hook types to spawn as children to this instance
// #### @callback {function} Continuation to respond to when complete
// Spawns the specified `hooks` as children to the current `Hook` instance.
//
Hook.prototype.spawn = require('./spawn').spawn;

Hook.prototype.log = function (hook, event, data) {
  var name  = hook.name  || 'no name specified',
      type  = hook.type  || 'no type specified';

  data  = data  || 'null';
  event = event || 'no event specified';

  //
  // TODO: Add the ability to filter what gets logged,
  //       based on the event namepace
  //
  if (typeof data === 'object') {
    data = JSON.stringify(data);
  }

  data = data.toString();

  if (this.debug) {

    //
    // Remark: The current approach to rendering to the console will break on really,
    // long event names or hook names or hook types. I will take a patch to make the,
    // the CLI reporter better.
    //
    //
    //       hook.emit('super::really::long::event::long::long:on:asdasdasdasdasdasdasd');
    //       ^^ will break console table formatting
    //
    //
    var truncatedData = data;

    var row_width = 83;

    console.log('Event: '.yellow.bold + pad(event, 30).yellow + ' Type: '.cyan.bold + pad(name, 15).cyan + ' Name: '.magenta.bold + pad(name, 15).magenta);
    console.log(' ┗' + ' Data: '.grey.bold + data.grey);
  }
};

Hook.prototype.getEvents = function () {
  return this.listenerTree;
};


Hook.prototype.mapEvents = function (eventMap) {

  var self = this;

  //
  // Iterate through each method and map it to the Hook
  //
  Object.keys(eventMap).forEach(function(event){
    self.on(event, eventMap[event]);
  });

};

//
// ### @private function _cliOptions (options)
// #### @options {Object} Object to serialize into command-line arguments.
// Serializes the specified `options` into a space delimited, double-dash `--`
// set of command-line arguments.
//
//    {
//      host: 'localhost',
//      port: 5010,
//      name: 'some-hook-name',
//      type: 'type-of-hook',
//      beep: 'boop'
//    }
//
//    --hook-host localhost --hook-port 5010 --hook-name some-hook-name --hook-type type-of-hook --beep boop
//
Hook.prototype._cliOptions = function (options) {
  var cli = [];
  
  //
  // TODO: Refactor 'reserved_cli' and module scoped 'reserved' into Protoype variable with nested namespaces
  //
  var reserved_cli = ['port', 'host', 'name', 'type'];

  Object.keys(options).forEach(function (key) {

    var value = options[key];

    if (typeof value === 'object') {
      value = JSON.stringify(value);
    }

    //
    // TODO: Some type inspection to ensure that only
    // literal values are accepted here.
    //
    if(reserved_cli.indexOf(key) === -1) {
      cli.push('--' + key, value);
    } else {
      cli.push('--hook-' + key, value);
    }
  });

  return cli;
};

//
// ### @private function _dnodeOptions ()
// Returns an Object literal for this instance to be passed
// to various dnode methods
//
Hook.prototype._dnodeOptions = function () {
  return {
    port:        this['hook-port'],
    path:        this.socket,
    key:         this.key,
    block:       this.block,
    reconnect:   this.reconnect
  };
};

function pad (str, len, chr) {
  var s;

  if(!chr){
    chr = ' ';
  }

  s = str;
  if (str.length < len) {
    for (var i = 0; i < (len - str.length); i++) {
      s += chr;
    }
  }
  return s;
}

function isIP(text) {
  var ipRegexp = /^((25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?).(25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?).(25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?).(25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?))|((([0-9A-Fa-f]{1,4}:){7}[0-9A-Fa-f]{1,4})|(([0-9A-Fa-f]{1,4}:){6}:[0-9A-Fa-f]{1,4})|(([0-9A-Fa-f]{1,4}:){5}:([0-9A-Fa-f]{1,4}:)?[0-9A-Fa-f]{1,4})|(([0-9A-Fa-f]{1,4}:){4}:([0-9A-Fa-f]{1,4}:){0,2}[0-9A-Fa-f]{1,4})|(([0-9A-Fa-f]{1,4}:){3}:([0-9A-Fa-f]{1,4}:){0,3}[0-9A-Fa-f]{1,4})|(([0-9A-Fa-f]{1,4}:){2}:([0-9A-Fa-f]{1,4}:){0,4}[0-9A-Fa-f]{1,4})|(([0-9A-Fa-f]{1,4}:){6}((b((25[0-5])|(1d{2})|(2[0-4]d)|(d{1,2}))b).){3}(b((25[0-5])|(1d{2})|(2[0-4]d)|(d{1,2}))b))|(([0-9A-Fa-f]{1,4}:){0,5}:((b((25[0-5])|(1d{2})|(2[0-4]d)|(d{1,2}))b).){3}(b((25[0-5])|(1d{2})|(2[0-4]d)|(d{1,2}))b))|(::([0-9A-Fa-f]{1,4}:){0,5}((b((25[0-5])|(1d{2})|(2[0-4]d)|(d{1,2}))b).){3}(b((25[0-5])|(1d{2})|(2[0-4]d)|(d{1,2}))b))|([0-9A-Fa-f]{1,4}::([0-9A-Fa-f]{1,4}:){0,5}[0-9A-Fa-f]{1,4})|(::([0-9A-Fa-f]{1,4}:){0,6}[0-9A-Fa-f]{1,4})|(([0-9A-Fa-f]{1,4}:){1,7}:))$/;
  
  return ipRegexp.test(text);
}

Hook.prototype.toIPs = function (host, callback) {
  if(!isIP(host)) {
    dns.resolve(host, function onResolve(err, hosts) {
      if(err)
        callback(err);
      else if (! (hosts.length) > 0)
        callback(new Error("Received invalid host list :"+ hosts));
      else
        callback(null, hosts);
    });
  }
  else
    callback(null, [host]);
}
