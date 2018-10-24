// -*- coding: utf-8 -*-
//-----------------------------------------------------------------------------
// file: $Id$
// auth: metagriffin <metagriffin@uberdev.org>
// date: 2012/12/22
// copy: (C) CopyLoose 2012 UberDev <hardcore@uberdev.org>, No Rights Reserved.
//-----------------------------------------------------------------------------

// for node compatibility...
if ( typeof(define) !== 'function')
  var define = require('amdefine')(module);

define([
  'stacktrace-js',
  'util',
  'fs',
  'path',
  'crypto',
  'underscore',
  'argparse',
  'indexeddb-js',
  'sqlite3',
  'syncml-js'
], function(
  stacktrace,
  util,
  fs,
  pathmod,
  crypto,
  _,
  argparse,
  indexeddbjs,
  sqlite3,
  syncml
) {

  // todo: move to a more generic logging package...
  var logging = syncml.logging;

  var log = logging.getLogger('sbt');
  var exports = {};

  var StdoutStream = syncml.common.Stream.extend({
    write: function(data) {
      util.print(data);
    }
  });

  //---------------------------------------------------------------------------
  var ItemStorage = syncml.common.Base.extend({

    constructor: function(options) {
      this.rootdir = options.rootdir;
      this.reldir  = options.reldir;
      this.label   = options.label;
    },

    // TODO: make `path` relative to Tool._opts.directory instead of `cwd`...

    _all: function(cb) {
      var self = this;
      var ret  = [];
      fs.readdir(pathmod.join(self.rootdir, self.reldir), function(err, files) {
        if ( err )
          return cb(err);
        syncml.common.cascade(files, function(file, cb) {
          var path = pathmod.join(self.reldir, file);
          fs.readFile(pathmod.join(self.rootdir, path), function(err, data) {
            if ( err )
              return cb(err);
            ret.push({path: path, data: data});
            return cb();
          });
        }, function(err) {
          if ( err )
            return cb(err);
          return cb(null, ret);
        });
      });
    },

    all: function(cb) {
      var self = this;
      self._all(function(err, items) {
        if ( err )
          return cb(err);
        return cb(null, _.map(items, function(item) {
          return JSON.parse(item.data);
        }));
      });
    },

    allMeta: function(cb) {
      var self = this;
      self._all(function(err, items) {
        if ( err )
          return cb(err);
        var ret = [];
        syncml.common.cascade(items, function(item, cb) {
          fs.stat(pathmod.join(self.rootdir, item.path), function(err, stat) {
            if ( err )
              return cb(err);
            var shasum = crypto.createHash('sha1');
            shasum.update(item.data);
            ret.push({
              id     : JSON.parse(item.data).id,
              path   : item.path,
              sha1   : shasum.digest('hex'),
              mtime  : Math.round(stat.mtime.getTime() / 1000)
            });
            cb();
          });
        }, function(err) {
          if ( err )
            return cb(err);
          return cb(null, ret);
        });
      });
    },

    add: function(item, cb) {
      var self = this;
      item.id = syncml.common.makeID();
      fs.writeFile(
        pathmod.join(self.rootdir, self.reldir, item.id + '.json'),
        syncml.common.prettyJson(item),
        function(err) {
          if ( err )
            return cb(err);
          log.info('store "%s": added item "%s"', self.label, item.id);
          return cb(null, item);
        }
      );
    },

    get: function(itemID, cb) {
      var self = this;
      fs.readFile(
        pathmod.join(self.rootdir, self.reldir, itemID + '.json'),
        function(err, data) {
          if ( err )
            return cb(err);
          return cb(null, JSON.parse(data));
        }
      );
    },

    replace: function(item, cb) {
      var self = this;
      fs.writeFile(
        pathmod.join(self.rootdir, self.reldir, item.id + '.json'),
        syncml.common.prettyJson(item),
        function(err) {
          if ( err )
            return cb(err);
          log.info('store "%s": replaced item "%s"', self.label, item.id);
          return cb();
        }
      );
    },

    delete: function(itemID, cb) {
      var self = this;
      fs.unlink(
        pathmod.join(self.rootdir, self.reldir, itemID + '.json'),
        function(err, data) {
          if ( err )
            return cb(err);
          log.info('store "%s": deleted item "%s"', self.label, itemID);
          return cb();
        }
      );
    },

    createStorage: function(cb) {
      // todo: should i check to see if the dir exists first?
      //       if so, check `force`? if `force`, clear out the dir?
      syncml.common.makedirs(pathmod.join(this.rootdir, this.reldir), cb);
    },

    removeStorage: function(cb) {
      syncml.common.rmfr(pathmod.join(this.rootdir, this.reldir), cb);
    }

  });

  //---------------------------------------------------------------------------
  var SbtAgent = syncml.Agent.extend({

    constructor: function(options) {
      this._storage = options.storage;
      this._contentTypes = options.contentTypes || [
        new syncml.ContentTypeInfo('*/*')
      ];
    },

    getContentTypes: function() {
      return this._contentTypes;
    },

    dumpsItem: function(item, contentType, version, cb) {
      return cb(null, item.body, item.type[0], item.type[1]);
    },

    loadsItem: function(data, contentType, version, cb) {
      var item = {type: [contentType, version], body: data};
      return cb(null, item);
    },

    getAllItems: function(cb) { return this._storage.all(cb); },
    addItem: function(item, cb) { return this._storage.add(item, cb); },
    getItem: function(itemID, cb) { return this._storage.get(itemID, cb); },
    replaceItem: function(item, reportChanges, cb) {
      this._storage.replace(item, cb);
    },
    deleteItem: function(itemID, cb) { return this._storage.delete(itemID, cb); }

  });

  //---------------------------------------------------------------------------
  // override the default help formatter so that the description is left as-is
  // todo: improve this by changing parser.description to be a structure that
  //       then results in calls to addSection() et al.
  var RawDescriptionHelpFormatter = function() {
    argparse.HelpFormatter.apply(this, arguments);
  };
  RawDescriptionHelpFormatter.prototype = new argparse.HelpFormatter();
  RawDescriptionHelpFormatter.prototype._rawText = function (text) {
    return text;
  };
  RawDescriptionHelpFormatter.prototype.addText = function (text) {
    if ( !! text && text.indexOf('SyncML Backup Tool') == 0 )
      return this._addItem(this._rawText, [text]);
    return argparse.HelpFormatter.prototype.addText.call(this, text);
  };

  //---------------------------------------------------------------------------
  exports.Tool = syncml.common.Base.extend({

    constructor: function(options) {
      this._opts = {};
      // TODO: figure out how to pull this dynamically from package.json...
      this._version = '0.0.10';
    },

    initialize: function(args, cb) {
      this._init(args, null, cb);
      return this;
    },

    //-------------------------------------------------------------------------
    _init: function(args, storedOptions, cb) {
      var self = this;
      var parser = new argparse.ArgumentParser({
        // TODO: figure out how to pull this dynamically from package.json...
        // version     : '0.0.6',
        addHelp     : true,
        usage       : '%(prog)s [-h|--help] [--version] [OPTIONS] COMMAND DIRECTORY',
        formatterClass : RawDescriptionHelpFormatter,
        description : 'SyncML Backup Tool (syncml-js)\n\nAvailable commands:\n'
          + '  discover              query and display the server\'s data structure\n'
          + '  backup                download server data, overriding local data\n'
          + '  sync                  synchronize remote and local changes\n'
          + '  restore               upload local data, overriding server data\n'
      });
      parser.addArgument(['--version'], {
        action       : 'storeTrue',
        help         : 'Show program\'s version number and exit.'
      });
      parser.addArgument(['-v', '--verbose'], {
        action       : 'count',
        help         : 'increase verbosity of program output'
      });
      parser.addArgument(['-q', '--quiet'], {
        action       : 'storeTrue',
        help         : 'suppress transaction results display'
      });
      parser.addArgument(['-a', '--append-log'], {
        dest         : 'appendLog',
        defaultValue : storedOptions ? storedOptions.appendLog : false,
        action       : 'storeTrue',
        help         : 'append logs to previous logs instead of overwriting'
      });
      parser.addArgument(['-A', '--no-append-log'], {
        dest         : 'noAppendLog',
        action       : 'storeTrue',
        help         : 'negates a current or previous "--append-log"'
      });

      // backup-specific arguments:
      parser.addArgument(['-f', '--force'], {
        action       : 'storeTrue',
        help         : 'during backup, if the DIRECTORY already exists, overwrite the contents'
      });
      parser.addArgument(['-u', '--username'], {
        metavar      : 'USERNAME',
        defaultValue : storedOptions ? storedOptions.username : null,
        help         : 'set the username for remote authorization'
      });
      parser.addArgument(['-p', '--password'], {
        metavar      : 'PASSWORD',
        defaultValue : storedOptions ? storedOptions.password : null,
        help         : 'set the password for the username specified with "--username"'
      });
      parser.addArgument(['-s', '--server'], {
        metavar      : 'URL',
        defaultValue : storedOptions ? storedOptions.server : null,
        help         : 'set the URL to the remote SyncML server'
      });
      parser.addArgument(['-i', '--include-store'], {
        metavar      : 'URI',
        dest         : 'stores',
        defaultValue : storedOptions ? storedOptions.stores : null,
        action       : 'append',
        help         : 'restrict remote data stores that are operated on to this set (can be specified multiple times to select multiple stores)'
      });
      parser.addArgument(['-e', '--exclude-store'], {
        metavar      : 'URI',
        dest         : 'xstores',
        defaultValue : storedOptions ? storedOptions.xstores : null,
        action       : 'append',
        help         : 'exclusive version of --include-store (i.e. specifies the inverse set)'
      });


      // todo: ideally, i'd like to declare that sbt takes 2 positional
      //       parameters - regardless of where the options are. unfortunately,
      //       that does not seem to be possible with argparse?...

      parser.addArgument(['command'], {
        choices      : ['discover', 'backup', 'sync', 'restore']
      });
      parser.addArgument(['directory'], {
        // dest         : 'directory',
        // required     : true,
        metavar      : 'DIRECTORY',
        help         : 'the directory to store all sync data'
      });

      self._opts = parser.parseArgs(args);
      if ( self._opts.noAppendLog )
        self._opts.appendLog = false;

      if ( ! storedOptions && _.indexOf(['backup'], self._opts.command) < 0 )
      {
        return fs.readFile(self._opts.directory + '/.sync/options.json', function(err, data) {
          if ( err )
            return cb(err);
          return self._init(args, JSON.parse(data), cb);
        });
      }

      self._initLogging(self._opts.command);
      return cb();
    },

    //-------------------------------------------------------------------------
    _initLogging: function(command) {
      var self = this;
      try{
        var stats = fs.statSync(self._opts.directory + '/.sync');
        if ( ! stats.isDirectory() )
          return;
      }catch(e){
        if ( e.code == 'ENOENT' )
          return;
        throw e;
      }
      logging.getLogger().addHandler(new logging.FileHandler({
        filename : self._opts.directory + '/.sync/sbt.log',
        append   : self._opts.appendLog
      }));
      log.info('initialized sbt with command "%s"', command);
    },

    //-------------------------------------------------------------------------
    _discover: function(cb) {
      var self = this;
      // note: using memory-based storage in order to ensure this is not
      //       serialized (since i'm trying to discover the current state)
      var sdb     = new sqlite3.Database(':memory:');
      var idb     = new indexeddbjs.makeScope('sqlite3', sdb);
      var ctxt    = new syncml.Context({storage: idb});
      ctxt.getEasyClientAdapter({
        displayName: 'SyncML Backup Tool (syncml-js) [discover]',
        devInfo: {
          devID               : 'sbt.discover.' + syncml.common.makeID(),
          devType             : syncml.DEVTYPE_WORKSTATION,
          manufacturerName    : 'metagriffin',
          modelName           : 'sbt (syncml-js/' + syncml.version + ')',
          softwareVersion     : self._version,
          hierarchicalSync    : false,
          extensions          : {
            'x-server-changes'        : 'notify',
            'x-single-session-device' : 'true'
          }
        },
        stores: [],
        peer: {
          url      : self._opts.server,
          auth     : syncml.NAMESPACE_AUTH_BASIC,
          username : self._opts.username,
          password : self._opts.password
        },
        routes: []
      }, function(err, adapter, stores, peer) {
        if ( err )
          return cb(err);
        adapter.sync(peer, syncml.SYNCTYPE_DISCOVER, function(err) {
          if ( err )
            return cb(err);
          return cb(null, peer);
        });
      });
    },

    //-------------------------------------------------------------------------
    discover: function(cb) {
      var s0 = new StdoutStream();
      var s1 = new syncml.common.IndentStream(s0);
      var self = this;
      self._discover(function(err, peer) {
        if ( err )
          return cb(err);
        s0.writeln('Remote peer:');
        peer.describe(s1, cb);
      });
    },

    //-------------------------------------------------------------------------
    _filterUris: function(uris) {
      var self = this;
      if ( this._opts.stores )
        uris = _.filter(uris, function(uri) {
          return _.indexOf(self._opts.stores, uri) >= 0;
        });
      if ( this._opts.xstores )
        uris = _.filter(uris, function(uri) {
          return _.indexOf(self._opts.xstores, uri) < 0;
        });
      return uris;
    },

    //-------------------------------------------------------------------------
    _prepDirectory: function(clear, cb) {
      var self = this;
      syncml.common.cascade([
        function(cb) {
          if ( self._opts.force )
            return syncml.common.rmfr(self._opts.directory, cb);
          fs.stat(self._opts.directory, function(err, stat) {
            if ( err && err.code == 'ENOENT' )
              return cb();
            if ( err )
              return cb(err);
            return cb('file or directory "' + self._opts.directory
                      + '" already exists (use --force to override)');
          });
        },
        _.bind(syncml.common.makedirs, null, self._opts.directory + '/.sync'),
        function(cb) {
          self._initLogging(self._opts.command);
          return cb();
        },
        _.bind(syncml.common.makedirs, null, self._opts.directory + '/stores'),
        _.bind(self._saveOptions, self)
      ], cb);
    },

    //-------------------------------------------------------------------------
    _saveOptions: function(cb) {
      var self = this;
      // TODO: i think the adapter already stores all of this... so is
      //       there really a need to store it again?
      var opts = _.pick(self._opts,
                        'server', 'username', 'password',
                        'stores', 'xstores',
                        'appendLog'
                       );
      fs.writeFile(
        self._opts.directory + '/.sync/options.json',
        syncml.common.prettyJson(opts),
        cb);
    },

    //-------------------------------------------------------------------------
    _takeSnapshot: function(adapter, cb) {
      var self     = this;
      var snapshot = {};
      syncml.common.cascade(adapter.getStores(), function(store, cb) {
        snapshot[store.uri] = {};
        store.agent._storage.allMeta(function(err, items) {
          if ( err )
            return cb(err);
          _.each(items, function(item) {
            snapshot[store.uri][item.id] = item;
          });
          return cb();
        });
      }, function(err) {
        if ( err )
          return cb(err);
        fs.writeFile(
          self._opts.directory + '/.sync/state.json',
          syncml.common.prettyJson(snapshot),
          cb);
      });
    },

    //-------------------------------------------------------------------------
    backup: function(cb) {
      var self = this;

      // setup the storage directory structure
      self._prepDirectory(true, function(err) {
        if ( err )
          return cb(err);

        self._discover(function(err, peer) {
          if ( err )
            return cb(err);
          var uris = _.map(peer.getStores(), function(store) {
            return store.uri;
          })
          log.debug('remote stores: ' + uris.join(', '));
          uris = self._filterUris(uris);
          log.debug('backing up stores: ' + uris.join(', '));
          var stores  = {};
          var routes  = {};
          var adapter = null;
          syncml.common.cascade([

            // configure local stores and agents
            function(cb) {
              syncml.common.cascade(uris, function(uri, cb) {
                log.debug('setting up local storage and agent for uri "%s"', uri);
                var pstore = peer.getStore(uri);
                var storage = new ItemStorage({
                  rootdir  : self._opts.directory,
                  reldir   : 'stores/' + syncml.common.urlEncode(uri),
                  label    : uri
                });
                storage.createStorage(function(err) {
                  if ( err )
                    return cb(err);
                  var agent   = new SbtAgent({
                    storage      : storage,
                    contentTypes : pstore.getContentTypes()
                  });
                  stores[uri] = {
                    uri          : uri,
                    displayName  : 'sbt backup of "' + uri + '"',
                    maxGuidSize  : syncml.common.platformBits(),
                    // note: funambol chokes on this... why?
                    // maxObjSize   : syncml.common.getMaxMemorySize(),
                    agent        : agent
                  };
                  routes[uri] = uri;
                  cb();
                });
              }, cb);
            },

            // execute the download sync
            function(cb) {
              // todo: should these be Tool member variables?...
              var sdb     = new sqlite3.Database(self._opts.directory + '/.sync/syncml.db');
              var idb     = new indexeddbjs.makeScope('sqlite3', sdb);
              var ctxt    = new syncml.Context({storage: idb});
              ctxt.getEasyClientAdapter({
                displayName: 'SyncML Backup Tool (syncml-js)',
                devInfo: {
                  devID               : 'sbt.' + syncml.common.makeID(),
                  devType             : syncml.DEVTYPE_WORKSTATION,
                  manufacturerName    : 'metagriffin',
                  modelName           : 'sbt (syncml-js/' + syncml.version + ')',
                  softwareVersion     : self._version,
                  hierarchicalSync    : false,
                  extensions          : {
                    'x-server-changes'  : 'notify'
                  }
                },
                stores: _.values(stores),
                peer: {
                  url      : self._opts.server,
                  auth     : syncml.NAMESPACE_AUTH_BASIC,
                  username : self._opts.username,
                  password : self._opts.password
                },
                routes: _.map(_.keys(routes), function(uri) { return [uri, uri]; })
              }, function(err, newAdapter, stores, peer) {
                if ( err )
                  return cb(err);
                adapter = newAdapter;
                adapter.sync(peer, syncml.SYNCTYPE_REFRESH_FROM_SERVER, function(err, stats) {
                  if ( err )
                    return cb(err);
                  return cb(null, stats);
                });
              });
            },

            // check the stats -- if any stores had errors, remove them from the set
            function(stats, cb) {
              if ( ! self._opts.quiet )
              {
                var s0 = new StdoutStream();
                syncml.describeStats(stats, s0, {
                  title: 'SyncML Backup Tool Results'
                });
              }
              syncml.common.cascade(_.keys(stats), function(uri, cb) {
                var stat = stats[uri];
                if ( ! stat.error && stat.peerErr <= 0 && stat.hereErr <= 0 )
                  return cb();
                var msg = ( stat.error && stat.error.message )
                  ? stat.error.message
                  : syncml.common.j(stat.error || stat);
                if ( ! self._opts.xstores )
                  self._opts.xstores = [];
                self._opts.xstores.push(uri);
                var store = adapter.getStore(uri);
                store.agent._storage.removeStorage(function(err) {
                  if ( err )
                    return cb(err);
                  adapter.removeStore(uri, function(err) {
                    if ( err )
                      return cb(err);
                    util.error('[**] ERROR: store "' + uri + '" failed:');
                    util.error('[**]   ' + msg);
                    util.error('[**] WARNING: store "' + uri
                               + '" was removed from the backup set.');
                  });
                });
                return cb();
              }, cb);
            },

            // save options (in case there was a store error and xstores was updated)
            _.bind(self._saveOptions, self),

            // re-save the adapter (since stores may have been removed)
            function(cb) { adapter.save(cb); },

            // take a snapshot (so that change detection can happen)
            function(cb) {
              self._takeSnapshot(adapter, cb);
            }

          ], cb);
        });
      });
    },

    //-------------------------------------------------------------------------
    _makeAgents: function(adapter, peer, cb) {
      var self = this;
      syncml.common.cascade(adapter.getStores(), function(store, cb) {
        var pstore = peer.getStore(store.uri);
        var storage = new ItemStorage({
          rootdir  : self._opts.directory,
          reldir   : 'stores/' + syncml.common.urlEncode(store.uri),
          label    : store.uri
        });
        store.agent = new SbtAgent({
          storage      : storage,
          contentTypes : pstore.getContentTypes()
        });
        cb();
      }, cb);
    },

    //-------------------------------------------------------------------------
    sync: function(cb) {
      var self = this;
      var s0   = new StdoutStream();
      // todo: should these be Tool member variables?...
      var sdb  = new sqlite3.Database(self._opts.directory + '/.sync/syncml.db');
      var idb  = new indexeddbjs.makeScope('sqlite3', sdb);
      var ctxt = new syncml.Context({storage: idb});
      var adapter = null;
      var peer    = null;

      syncml.common.cascade([

        // configure adapter
        function(cb) {
          ctxt.getAdapter(null, null, function(err, newAdapter) {
            if ( err )
              return cb(err);
            var peers = newAdapter.getPeers();
            if ( peers.length <= 0 )
              return cb('cannot sync: no known peer recorded');
            if ( peers.length != 1 )
              return cb('cannot sync: multiple peers recorded');
            self._makeAgents(newAdapter, peers[0], function(err) {
              if ( err )
                return cb(err);
              adapter = newAdapter;
              peer    = peers[0];
              cb();
            });
          });
        },

        // detect changes
        function(cb) {
          fs.readFile(self._opts.directory + '/.sync/state.json', function(err, data) {
            var prev = JSON.parse(data);
            syncml.common.cascade(adapter.getStores(), function(store, cb) {
              store.agent._storage.allMeta(function(err, items) {
                if ( err )
                  return cb(err);
                pitems = prev[store.uri];
                if ( ! pitems )
                  return cb('unexpected store "' + store.uri + '" (not in state.json)');
                // search for added/changed items
                syncml.common.cascade(items, function(item, cb) {
                  if ( ! pitems[item.id] )
                    return store.registerChange(item.id, syncml.ITEM_ADDED, null, cb);
                  pitems[item.id].checked = true;
                  if ( pitems[item.id].sha1 != item.sha1 )
                    return store.registerChange(item.id, syncml.ITEM_MODIFIED, null, cb);
                  return cb();
                }, function(err) {
                  if ( err )
                    return cb(err);
                  // search for deleted items
                  syncml.common.cascade(_.keys(pitems), function(itemID, cb) {
                    var item = pitems[itemID];
                    if ( item.checked )
                      return cb();
                    return store.registerChange(item.id, syncml.ITEM_DELETED, null, cb);
                  }, cb);
                });
              });
            }, cb);
          });
        },

        // execute the sync
        function(cb) {
          adapter.sync(peer, syncml.SYNCTYPE_TWO_WAY, function(err, stats) {
            if ( err )
              return cb(err);
            if ( ! self._opts.quiet )
              syncml.describeStats(stats, s0, {
                title: 'SyncML Backup Tool Results'
              });
            return cb();
          });
        },

        // record the current state
        function(cb) {
          self._takeSnapshot(adapter, cb);
        }

      ], cb);
    },

    //-------------------------------------------------------------------------
    restore: function(cb) {
      var self = this;
      var s0   = new StdoutStream();
      // todo: should these be Tool member variables?...
      var sdb  = new sqlite3.Database(self._opts.directory + '/.sync/syncml.db');
      var idb  = new indexeddbjs.makeScope('sqlite3', sdb);
      var ctxt = new syncml.Context({
        storage:  idb,
        // create a listener that will forbid any changes in synctype
        // TODO: upgrade this to use options.ua instead...
        listener: function(event) {
          if ( ! event || event.type != 'sync.mode.switch' )
            return;
          var msg = 'server vexingly changed synctype from "'
            + syncml.common.mode2string(event.modeReq)
            + '" to "'
            + syncml.common.mode2string(event.mode)
            + '"';
          console.log(msg + ' - aborting');
          throw new syncml.common.LogicalError(msg);
        }
      });
      var adapter = null;
      var peer    = null;
      syncml.common.cascade([

        // configure adapter
        function(cb) {
          ctxt.getAdapter(null, null, function(err, newAdapter) {
            if ( err )
              return cb(err);
            var peers = newAdapter.getPeers();
            if ( peers.length <= 0 )
              return cb('cannot sync: no known peer recorded');
            if ( peers.length != 1 )
              return cb('cannot sync: multiple peers recorded');
            // TODO: put the stores in read-only state...
            self._makeAgents(newAdapter, peers[0], function(err) {
              if ( err )
                return cb(err);
              adapter = newAdapter;
              peer    = peers[0];
              cb();
            });
          });
        },

        // execute the sync
        function(cb) {
          adapter.sync(peer, syncml.SYNCTYPE_REFRESH_FROM_CLIENT, function(err, stats) {
            if ( err )
              return cb(err);
            if ( ! self._opts.quiet )
              syncml.describeStats(stats, s0, {
                title: 'SyncML Backup Tool Results'
              });
            return cb();
          });
        },

        // todo: if the stores are read-only, then no state change should be
        //       possible...

        // record the current state
        function(cb) {
          self._takeSnapshot(adapter, cb);
        }

      ], cb);
    },

    //-------------------------------------------------------------------------
    version: function(cb) {
      util.puts(this._version);
      return cb();
    },

    //-------------------------------------------------------------------------
    exec: function(cb) {
      var self = this;
      var ch = new logging.ConsoleHandler();
      switch ( this._opts.verbose )
      {
        case null:
        case 0:  ch.level = logging.ERROR; break;
        case 1:  ch.level = logging.INFO;    break;
        case 2:  ch.level = logging.DEBUG;   break;
        default:
        case 3:  ch.level = logging.NOTSET;  break;
      }
      logging.getLogger().addHandler(ch);
      if ( this._opts.version )
        return this.version(cb);
      return this[this._opts.command].call(this, function(err) {
        if ( err )
        {
          if ( self._opts.verbose > 0 )
            util.error(stacktrace().join('\n'));
          return cb(err);
        }
        self._saveOptions(cb);
      });
    }

  }, {

    //-------------------------------------------------------------------------
    main: function(args, cb) {
      if ( ! cb )
        cb = function(err) {
          if ( err )
            util.error('[**] ERROR: '
                       + ( err.message
                           ? err.message
                           : ( _.isObject(err)
                               ? syncml.common.j(err)
                               : err )));
        };
      var tool = new exports.Tool();
      tool.initialize(args, function(err) {
        if ( err )
          return cb(err);
        tool.exec(cb);
      });
    }

  });

  return exports;

});

//-----------------------------------------------------------------------------
// end of $Id$
//-----------------------------------------------------------------------------
