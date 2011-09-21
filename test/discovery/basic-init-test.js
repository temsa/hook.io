/*
 * test-basic-test.js: Basic tests for the hook.io module
 *
 * (C) 2011 Marak Squires, Charlie Robbins
 * MIT LICENCE
 *
 */

var vows = require('vows'),
    assert = require('assert'),
    Hook = require('../../lib/hookio').Hook,
    macros = require('../helpers/macros');

vows.describe('hook.io/discovery/basic-init').addBatch({
  "When a Hook is listening on 5011": macros.assertListen('simple-listen', 5011, {
    "and another hook attempts to `.listen()` on 5011": {
      topic: function () {
        var instance = new Hook({ name: 'simple-error' });
        instance.onAny(console.log)
        instance.once('error::*', this.callback.bind(instance, null));
        instance.listen({ "hook-port": 5011}/*, this.callback.bind(instance, null)*/);
      },
      "it should fire the `error` event": function (_, destination) {
        assert.equal(this.event, 'error::bind');
        assert.isString(destination);
      }
    }
  })
}).addBatch({
  "When a Hook is listening on 5010": macros.assertListen('simple-listen', 5010, {
    "and another hook attempts to `.connect()`": macros.assertConnect('simple-connect', 5010),
    "and another hook attempts to `.start()`": macros.assertReady('simple-start', 5010)
  })
}).export(module);
