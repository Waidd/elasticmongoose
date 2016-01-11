'use strict';

var elasticSearch = require('elasticsearch'),
   mongoose, /* pass in mongoose object*/
   _ = require('underscore'),
   Q = require('q'),
   winston = require('winston'),
   async = require('async');

function ElasticMongoose() {
   this.initialized = false;
   this.client = null;
   this.mapping = {};
   this.models = {};
   this.logger = new(winston.Logger)({
      transports: [new(winston.transports.File)({
         filename: 'elasticmongoose.log'
      })]
   });
   this.options = {
      host: 'localhost:9200',
      index: 'elasticgoose',
      bulkPush: 200,
      apiVersion: '1.4',
      findMethod: function (model, data, callback) {
         model.findOne({
            '_id': data._id
         }, function (err, instance) {
            callback(err, instance);
         });
      },
      logLevel: 'ERROR'
   };
}

ElasticMongoose.prototype.connect = function ( /* Mongoose Object*/ mongoose, callback, options) {
   this.mongoose = mongoose;
   this.options = _.defaults({}, options || {}, this.options);
   this.initialized = true;

   this.client = new elasticSearch.Client({
      host: this.options.host,
      log: this.options.log,
      apiVersion: this.options.apiVersion
   });

   this.client.ping({
      requestTimeout: 10000,
      hello: 'elasticsearch!'
   }, function (err) {
      callback(err);
   });
};

ElasticMongoose.prototype.putMapping = function (callback, options) {
   var body = {};
   body[options.type] = this.mapping[options.type];

   this.client.indices.putMapping({
      index: options.index || this.options.index,
      type: options.type,
      ignoreConflicts: true,
      body: body
   }, function (err, resp) {
      callback(err, resp);
   });
};

ElasticMongoose.prototype.truncate = function (callback, options) {
   options = options || {};
   options.index = options.index || this.options.index;

   this.client.deleteByQuery({
      index: options.index,
      body: {
         query: {
            match_all: {}
         }
      }
   }, function (err, resp) {
      callback(err, resp);
   });
};

ElasticMongoose.prototype.flush = function (callback, options) {
   options = options || {};
   options.index = options.index || this.options.index;

   this.client.indices.flush(options, function (err, resp) {
      callback(err, resp);
   });
};

ElasticMongoose.prototype.refresh = function (callback, options) {
   options = options || {};
   options.index = options.index || this.options.index;

   this.client.indices.refresh(options, function (err, resp) {
      callback(err, resp);
   });
};

ElasticMongoose.prototype.synchronizeModel = function (modelName, callback) {
   var self = this;
   var schema = this.models[modelName].schema;
   var options = this.models[modelName].options;
   var model = this.mongoose.model(modelName);
   var indexes = [];
   var item = [];
   var count = 0;

   _getElasticKeysForSchema(schema, function (keys) {
      var stream = model.find().stream();
      stream.on('data', function (obj) {
         stream.pause();
         item = _createBulkIndexData(self, obj, schema, keys, options, function (item) {
            indexes = indexes.concat(item);
            if (count !== 0 && count % self.options.bulkPush === 0) {
               self.debugCallback('Pushing ' + self.options.bulkPush + ' bulk items', '');
               self.bulk(indexes, function () {
                  indexes = [];
               });
            }
            stream.resume();
            count++;
         });
      }).on('error', function (err) {
         self.errorCallback('synchronize operation failed', err);
         callback(err);
      }).on('close', function () {
         // flush the indexes array
         self.bulk(indexes);
         self.debugCallback('streamed ' + count + ' from ' + modelName, '');
         callback();
      });
   });
};


ElasticMongoose.prototype.synchronizeAll = function (callback) {
   var errors = [];

   var onFinish = _.after(Object.keys(this.models).length, function () {
      if (errors.length) {
         callback(errors);
      } else {
         callback();
      }
   });

   for (var modelName in this.models) {
      this.synchronizeModel(modelName, function (err) {
         if (err) {
            errors.push(err);
         }
         onFinish();
      });
   }
};

ElasticMongoose.prototype.search = function (options, query, callback, info) {
   var deferred = Q.defer();
   var self = this;

   options = _.defaults({}, options, {
      index: this.options.index
   });
   options.query = query;

   deferred.resolve(options);

   deferred.promise.then(function (options) {
      var deferred = Q.defer();

      self.client.search({
         index: options.index,
         type: options.type,
         body: {
            query: options.query
         },
         from: options.from ? options.from : 0,
         size: options.size ? options.size : 10
      }, function (err, resp) {
         if (err) {
            deferred.reject(err);
         } else {
            deferred.resolve(resp.hits);
         }
      });

      return deferred.promise;
   }).then(function (resp) {
      var deferred = Q.defer();

      self.debugCallback('elasticsearch brut result', resp);

      if (resp.hits.length === 0) {
         deferred.resolve([]);
         return deferred.promise;
      }

      var modelNames = self.mongoose.modelNames();
      var data = [];
      var after = _.after(resp.hits.length, function () {
         deferred.resolve(data);
      });

      resp.hits.forEach(function (value) {
         if (_.indexOf(modelNames, value._type) === -1) {
            self.errorCallback('search failed', 'model is not defined');
            after();
            return;
         }

         var model = self.mongoose.model(value._type);
         var findMethod = model.schema.methods.elasticFind ? model.schema.methods.elasticFind : self.options.findMethod;

         findMethod(model, value, function (err, instance) {
            if (err) {
               deferred.reject(err);
            } else if (instance !== null) {
               data.push(instance);
            } else {
               self.warningCallback('search object not found', value);
            }
            after();
         }, info);
      });

      return deferred.promise;
   }).then(function (data) {
      callback(null, data);
   }, function (err) {
      callback(err);
   });
};

ElasticMongoose.prototype.mongoosePlugin = function () {
   var self = this;

   function mapGeojson(type) {
      self.mapping[type] = {
         properties: {
            location: {
               type: 'geo_point'
            }
         }
      };
   }

   function mapObject(type) {
      self.mapping[type] = {
         type: 'object'
      };
   }

   return function (schema, options) {
      options = (typeof options === 'string') ? {
         type: options
      } : options;
      self.models[options.type] = {
         schema: schema,
         options: options
      };

      for (var key in schema.paths) {
         var elastic = schema.paths[key].options.elastic;
         if (elastic === 'geojson') {
            mapGeojson(options.type);
         } else if (elastic === 'object') {
            mapObject(options.type);
         }
      }
      schema.post('save', function (obj) {
         self.index(obj, schema, options);
      });
      schema.post('remove', function (obj) {
         self.remove(obj, options);
      });
   };
};

ElasticMongoose.prototype.remove = function (obj, options) {
   var self = this;

   this.client.delete({
      index: options.index ? options.index : self.options.index,
      type: options.type,
      id: String(obj._id)
   }, function (err, resp) {
      if (err) {
         self.errorCallback('delete operation failed', err);
      } else if (!err) {
         self.infoCallback('delete operation succeed', resp);
      }
   });
};

// get the elastic keys from the schema
function _getElasticKeysForSchema(schema, callback) {
   var elastics = [];
   for (var key in schema.paths) {
      if (schema.paths[key].options.elastic) {
         elastics.push(key);
      }
   }
   callback(elastics);
}

// go through each field in the object, 
// decide if it is 'elastic', and format it
function _createFields(obj, schema, keys, cb) {

   var fields = {};

   async.each(keys, function (key, callback) {
         // ex. true, false, function, array 
         var elastic = schema.paths[key].options.elastic;
         var item = obj[key];

         if (item) {
            if (typeof elastic === 'function') {
               elastic(obj, fields, function (err, result) {
                  fields[key] = result;
                  callback();
               });
            } else {
               if (elastic === true || elastic === 'object') {
                  fields[key] = item;
                  //@todo: Make this recursively search an array
               } else if (elastic === 'array') {
                  for (var key2 in item) {
                     fields[key2] = item[key2];
                  }
               } else if (elastic === 'geojson') {
                  if (obj.coordinates) {
                     var location = {
                        lat: item.coordinates[1],
                        lon: item.coordinates[0]
                     };
                     fieldAccumulator('location', location);
                  }
               }
               callback();
            }
         } else {
            callback();
         }
      },
      function (err) {
         cb(fields);
      }
   );
}

function _createBulkIndexData(self, obj, schema, keys, options, callback) {
   _createFields(obj, schema, keys, function (fields) {
      var result = [];
      result = [{
            'index': {
               '_index': options.index ? options.index : self.options.index,
               '_type': options.type,
               '_id': String(obj._id)
            }
         },
         fields
      ];
      callback(result);
   });
}

ElasticMongoose.prototype.index = function (obj, schema, options) {
   var self = this;
   _getElasticKeysForSchema(schema, function (keys) {
      _createFields(obj, schema, keys, function (fields) {
         self.client.index({
               index: options.index ? options.index : self.options.index,
               type: options.type,
               id: String(obj._id),
               body: fields
            },
            function (err, resp) {
               if (err) self.errorCallback('save operation failed', err);
               else if (!err) self.infoCallback('save operation succeed', resp);
            });
      });
   });

};


ElasticMongoose.prototype.bulk = function (data, callback) {
   var self = this;

   // @todo: provide some validation here
   this.client.bulk({
         body: data
      },
      function (err, resp) {
         if (err) self.errorCallback('bulk operation failed', err);
         else if (!err) self.infoCallback('bulk operation succeed', resp);
         if (callback) {
            callback();
         }

      });
};

ElasticMongoose.prototype.debugCallback = function (msg, data) {
   if (['DEBUG'].indexOf(this.options.logLevel) !== -1)
      this.logger.log(msg, data);
};

ElasticMongoose.prototype.infoCallback = function (msg, data) {
   if (['INFO', 'DEBUG'].indexOf(this.options.logLevel) !== -1)
      this.logger.info(msg, data);
};

ElasticMongoose.prototype.warningCallback = function (msg, data) {
   if (['WARNING', 'INFO', 'DEBUG'].indexOf(this.options.logLevel) !== -1)
      this.logger.warn(msg, data);
};

ElasticMongoose.prototype.errorCallback = function (msg, data) {
   if (['ERROR', 'WARNING', 'INFO', 'DEBUG'].indexOf(this.options.logLevel) !== -1)
      this.logger.error(msg, data);
};

module.exports = exports = new ElasticMongoose();