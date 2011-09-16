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

  var config = this.config.store.store;
  Object.keys(config).forEach(function (o) {
    self[o] = config[o];
  });

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
  this.defaults['hook-host']   = options['hook-host']   || argv['hook-host']   || '0.0.0.0';
  this.defaults['hook-socket'] = options['hook-socket'] || argv['hook-socket'] || null;

  this.npm = npm;

  //
  // Assign message transports for this hook
  //
  this.transports = this.transports || [];

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
  function onDetails(options) {
      options = options || {};
      var name = options.name,
          type = options.type,
          host = options.host
          callback = options.callback;    
       
      if(!((self.server||{}).server))
        return ;

      if(typeof callback !== "function") {
        return self.emit("error", new Error("When using 'hookDetails' event, option 'callback' is mandatory and should be a function"))
      }

      if(name) {
        if (name in self._names) {
          callback(null, self._names[name]);
				} else { 
          callback(new Error("No hook named "+name+" is connected (anymore?)"));
        }
      } else if (type) {
        var details = Object.keys(self._names)
          .map(function(key){ if(self._names[key].type === type) return self._names[key]; })
          .filter(function(detail){return detail});
          
        if(details.length>0) {
          callback(null, details);
				} else {
          callback(new Error("No hook of type "+type+" is connected (anymore?)"),[]);
        }
      } else if(host) {
          toIPs(host, function onIP(err, hosts) {
            var details = Object.keys(self._names).map(function getHooks(key) {
              if( hosts.some( function hasHost (host){
                  return host === self._names[key].remote.host
										|| ((isLocalIP(host) || isWildcardIP(host))
											&& self._names[key].server
											&& isWildcardIP(self._names[key].remote.host))} ) ) {
                  //FIXME test is not perfect but should be ok most of the time, if we ask for a local adress we are probably on the same host
                return self._names[key];
              }
            }).filter(function(detail){return detail});
              
            if(details.length>0)
              callback(null, details);
            else
              callback(new Error("No hook for host "+host+" is connected (anymore?)"),[]);
          });
      } else {
				var details = Object.keys(self._names)
        	.map(function(key){ return self._names[key]; })
				callback(null, details);
			}
  }
  this.on("*::hookDetails", onDetails);
  this.on("hookDetails", onDetails);

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
  this.log(this.name, event, data);

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

    this.remote.message(this.name + DELIMITER + event, data, callback, broadcast);
  }

  return EventEmitter.prototype.emit.apply(this, [event, data, broadcast]);
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
      if (err.code == 'EADDRINUSE' || err.code == 'EADDRNOTAVAIL') {
        self.emit('error::bind', self['hook-host'] +':'+self['hook-port']);
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
  toIPs(self['hook-host'], function onResolve(err, hosts){
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
      },
      server:true
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

        if(reported) //FIXME wasn't necessary before ? fails on basic-spawn test, reported is not defined
          reported(client.name);
      };

      this.message = function (event, data, callback, group) {
        self.emit(event, data, callback, group||true);
      };

      //
      // On incoming events to the server,
      // send those events as messages to all clients
      //
      self.onAny(function (data, remote) {
					var parts = this.event.split(DELIMITER),
            event = !remote ? [self.name, this.event].join(DELIMITER) : this.event;
				if(!!remote !== remote) {// not boolean => restricting group
					var group = Array.isArray(remote) ? remote : [remote];

					//FIXME give the possibility of having 'pirate' hooks which listens to everything (but data ?), e.g. hookio-logger
					if ((client.name &&	group.some(function(name){return name === client.name}))) { 
						client.hasEvent(parts, remote, function(err, send) {
           		if(!send) return self.emit('hook::noevent', event);
            		client.message(event, data);
          	});
					}
					return;
				}
        //
        // Only broadcast if the client has a message function, it is not a reserved 
        // (i.e. local-only: 'hook::*', 'connection::*' or 'children::*') and 
        // the event was not broadcast by the client itself (e.g. no circular transmissions)
        //
				if (client.message && reserved.indexOf(parts[0]) === -1 && parts[0] !== client.name) {
          self.transports.forEach(function(transport) {
            _transports[transport.type].message(transport.options, event, data);
          });
          
          // before sending any message, request client for registered events
          // and send message with data only if the client is interrested in this event
          client.hasEvent(parts, remote, function(err, send) {
            if(!send) return self.emit('hook::noevent', event);
            client.message(event, data);
          });
        }
      });
    });
  
    
    self.server.on('connection', function (conn) {
      self.emit('connection::open', conn);
    });

    self.server.on('error', function (err) {
      if(callback) {
        callback(err);
      }
    });

    self.server.on('ready', function (err) {
      self.emit('hook::listening', self['hook-host'] + ':' + self['hook-port']);
      self.emit('hook::ready', self['hook-host'] + ':' +self['hook-port']);
      if (callback) {
        callback();
      }
    });


    //
    // Remark: Hook discovery could be improved, but needs the semantic
    // and cardinality to be better defined.
    //
    try {
      self.server.listen(self['hook-port'], self['hook-host']);
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
    message: function (event, data) {
      self.emit(event, data, true);
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
Hook.prototype.spawn = function (hooks, callback) {
  var self = this,
      connections = 0,
      local,
      names;
  
  function onError (err) {
    self.emit('error::spawn', err);
    if (callback) {
      callback(err);
    }
  }
  
  if (!this.listening) {
    return onError(new Error('Cannot spawn child hooks without calling `.listen()`'));
  }  

  if(typeof hooks === "string") {
    hooks = new Array(hooks);
  }

  var types = {};
  
  if (typeof hookio.forever === 'undefined') {
    //
    // Attempt to `require('forever')` and if it is available
    // then spawn all 
    //
    try {
      hookio.forever = require('forever');
    }
    catch (ex) {
      //
      // Remark: Should we be warning the user here?
      //
      hookio.forever = ex;
    }
  }
  
  //
  // Spawn in-process (i.e. locally) if `hookio.forever` has been set
  // purposefully to `false` or if it is an instance of an `Error` 
  // (i.e. it had previously failed to be required). 
  //
  local = self.local || !hookio.forever || hookio.forever instanceof Error;

  function spawnHook (hook, next) {
    var hookModule,
        hookBin = __dirname + '/../../bin/forever-shim',
        options,
        child,
        keys;

    if(typeof hook === 'string') {
      hook = {
        name: hook,
        type: hook
      };
    }

    hook['host'] = hook['host'] || self['hook-host'];
    hook['port'] = hook['port'] || self['hook-port'];

    hookModule = 'hook.io-' + hook.type;

    //
    // Remark: Special case for spawning vanilla hooks,
    // since the module name is `hook.io` and not `hook.io-hook`
    //
    if (hookModule === 'hook.io-hook') {
      hookModule = 'hook.io';
    }
    
    self.emit('hook::spawning', hook.name);

    if (local) {
      //
      // Create empty object in memory and dynamically require hook module from npm
      //
      self.children[hook.name] = {
        module: require(hookModule)
      };

      //
      // Here we assume that the `module.exports` of any given `hook.io-*` module
      // has **exactly** one key. We extract this Hook prototype and instantiate it.
      //
      keys = Object.keys(self.children[hook.name].module);
      self.children[hook.name].Hook  = self.children[hook.name].module[keys[0]];
      self.children[hook.name]._hook = new (self.children[hook.name].Hook)(hook);

      //
      // When the hook has fired the `hook::ready` event then continue.
      //
      self.children[hook.name]._hook.once('hook::ready', next.bind(null, null));
      self.children[hook.name]._hook.connect(self);
    }
    else {

      try { require.resolve(hookModule); }
      catch (ex) { return next(ex) }

      //
      // TODO: Make `max` and `silent` configurable through the `hook.config`
      // or another global config.
      //
      options = {
        max: 10,
        silent: false,
        logFile: path.join('./forever-' + hook.type + '-' + hook.name)
      };

      options.options = self._cliOptions(hook);

      child = new (hookio.forever.Monitor)(hookBin, options);
      child.on('start', function onStart (_, data) {
        //
        // Bind the child into the children and move on to the next hook
        //
        self.children[hook.name] = {
          bin: hookBin,
          monitor: child
        };
        
        self.emit('child::start', hook.name, self.children[hook.name]);
        next();
      });
      
      child.on('restart', function () {
        self.emit('child::restart', hook.name, self.children[hook.name]);
      });
      
      child.on('exit', function (err) {
        //
        // Remark: This is not necessarily a bad thing. Hooks are not by definition
        // long lived processes (i.e. worker-hooks, tbd).
        //
        self.emit('child::exit', hook.name, self.children[hook.name]);
      });

      child.start(); 
    }
  }
  
  self.on('client::connected', function onConnect (data) {
    connections++;
    if (connections === hooks.length) {
      self.emit('children::ready', hooks);
      self.off('client::connected', onConnect);
    }
  });
  
  async.forEach(hooks, spawnHook, function (err) {
    if (err) {
      return onError(err);
    }

    self.emit('children::spawned', hooks);
    if (callback) {
      callback();
    }
  });
  
  return this;
};

Hook.prototype.log = function (hook, event, data) {
  hook  = hook  || 'no name specified';
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
    var truncatedData = data.length > 50
      ? data.substr(0, 50) + ' ... '
      : truncatedData = data;

    console.log(pad(hook, 30).magenta, pad(event, 25).green, truncatedData.grey);
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
}

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
  // TODO: Refactor 'reserved_cli' and module scopeds 'reserved' into Protoype variable with nested namespaces
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
    host:        this['hook-host'],
    path:        this.socket,
    key:         this.key,
    block:       this.block,
    reconnect:   this.reconnect
  };
};

function pad (str, len) {
  var s;
  s = str;
  if (str.length < len) {
    for (var i = 0; i < (len - str.length); i++) {
      s += ' '
    }
  }
  return s;
}

function isIP(text) {
  var ipRegexp = /^((25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?).(25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?).(25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?).(25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?))|((([0-9A-Fa-f]{1,4}:){7}[0-9A-Fa-f]{1,4})|(([0-9A-Fa-f]{1,4}:){6}:[0-9A-Fa-f]{1,4})|(([0-9A-Fa-f]{1,4}:){5}:([0-9A-Fa-f]{1,4}:)?[0-9A-Fa-f]{1,4})|(([0-9A-Fa-f]{1,4}:){4}:([0-9A-Fa-f]{1,4}:){0,2}[0-9A-Fa-f]{1,4})|(([0-9A-Fa-f]{1,4}:){3}:([0-9A-Fa-f]{1,4}:){0,3}[0-9A-Fa-f]{1,4})|(([0-9A-Fa-f]{1,4}:){2}:([0-9A-Fa-f]{1,4}:){0,4}[0-9A-Fa-f]{1,4})|(([0-9A-Fa-f]{1,4}:){6}((b((25[0-5])|(1d{2})|(2[0-4]d)|(d{1,2}))b).){3}(b((25[0-5])|(1d{2})|(2[0-4]d)|(d{1,2}))b))|(([0-9A-Fa-f]{1,4}:){0,5}:((b((25[0-5])|(1d{2})|(2[0-4]d)|(d{1,2}))b).){3}(b((25[0-5])|(1d{2})|(2[0-4]d)|(d{1,2}))b))|(::([0-9A-Fa-f]{1,4}:){0,5}((b((25[0-5])|(1d{2})|(2[0-4]d)|(d{1,2}))b).){3}(b((25[0-5])|(1d{2})|(2[0-4]d)|(d{1,2}))b))|([0-9A-Fa-f]{1,4}::([0-9A-Fa-f]{1,4}:){0,5}[0-9A-Fa-f]{1,4})|(::([0-9A-Fa-f]{1,4}:){0,6}[0-9A-Fa-f]{1,4})|(([0-9A-Fa-f]{1,4}:){1,7}:))$/;
  
  return ipRegexp.test(text);
}

function isLocalIP(text) {
  var localIpRegexp = /^((127\.(25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.(25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.(25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?))|(::0{0,3}1)|((0{1,4}:)+:0{0,3}1)|((0{1,4}:){7}:0{0,3}1))$/;
  return localIpRegexp.test(text);
}

function isWildcardIP(text) {
  var wildcardIpRegexp = /^((0\.0\.0\.0)|(::0{0,4})|((0{1,4}:)+:0{1,4})|((0{1,4}:){7}:0{1,4}))$/;
  return wildcardIpRegexp.test(text);
}

function toIPs(host, callback) {
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
