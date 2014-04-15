'use strict';

var	elasticSearch = require('elasticsearch'),
	mongoose = require('mongoose'),
	_ = require('underscore'),
	Q = require('q'),
	winston = require('winston');

function ElasticMongoose() {
	this.initialized = false;
	this.client = null;
	this.mapping = {};
	this.logger =  new (winston.Logger)({
	    transports: [new (winston.transports.File)({ filename: 'elasticmongoose.log' })]
	});
	this.options = {
		host: 'localhost:9200',
		index: 'elasticmongoose',
		apiVersion: '0.90',
		findMethod: function(model, data, callback){
			model.findOne({ '_id': data._id}, function(err, instance) {
				callback(err, instance);
			});
		},
		logLevel: 'ERROR'
	};
}

ElasticMongoose.prototype.connect = function(callback, options) {
	this.options = _.defaults({}, options || {}, this.options);
	this.initialized = true;

	this.client = new elasticSearch.Client({
		host: this.options.host,
		log: this.options.log,
		apiVersion: this.options.apiVersion
	});

	this.client.ping({
		requestTimeout: 1000,
		hello: 'elasticsearch!'
	}, function (err) {
		callback(err);
	});
};

ElasticMongoose.prototype.putMapping = function(callback, options) {
	var body = {};
	body[options.type] = this.mapping[options.type];

	this.client.indices.putMapping({
		index: options.index || this.options.index,
		type: options.type,
		ignoreConflicts: true,
		body: body
	}, function(err, resp) {
		callback(err, resp);
	});
};

ElasticMongoose.prototype.truncate = function(callback, options) {
	options = options || {};
	options.index = options.index || this.options.index;

	this.client.deleteByQuery({
		index: options.index,
		type: '*',
		q: '*'
	}, function(err, resp) {
		callback(err, resp);
	});
};

ElasticMongoose.prototype.refresh = function(callback, options) {
	options = options || {};
	options.index = options.index || this.options.index;

	this.client.indices.refresh(options, function(err, resp) {
		callback(err, resp);
	});
};

ElasticMongoose.prototype.search = function(options, query, callback, info) {
	var deferred = Q.defer();
	var self = this;

	options = _.defaults({}, options, {index: this.options.index});
	options.query = query;

	deferred.resolve(options);

	deferred.promise.then(function(options) {
		var deferred = Q.defer();

		self.client.search({
			index: options.index,
			type: options.type,
			body: {query: options.query},
			from: options.from ? options.from : 0,
			size: options.size ? options.size : 10
		}, function(err, resp) {
			if(err) deferred.reject(err);
			else deferred.resolve(resp.hits);
		});

		return deferred.promise;
	}).then(function(resp) {
		var deferred = Q.defer();

		self.debugCallback('elasticsearch brut result', resp);

		if (resp.hits.length === 0) {
			deferred.resolve([]);
			return deferred.promise;
		}

		var modelNames = mongoose.modelNames();
		var data = [];
		var after = _.after(resp.hits.length, function() {
			deferred.resolve(data);
		});

		resp.hits.forEach(function(value) {
			if (_.indexOf(modelNames, value._type) === -1) {
				self.errorCallback('search failed', 'model is not defined');
				after();
				return;
			}

			var model = mongoose.model(value._type);
			var findMethod = model.schema.methods.elasticFind ? model.schema.methods.elasticFind : self.options.findMethod;

			findMethod(model, value, function(err, instance) {
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
	}).then(function(data){
		callback(null, data);
	}, function(err){
		callback(err);
	});
};

ElasticMongoose.prototype.mongoosePlugin = function() {
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

	return function(schema, options) {
		options = (typeof options === 'string') ? {type: options} : options;

		for (var key in schema.paths) {
			var elastic = schema.paths[key].options.elastic;
			if (elastic === 'geojson') {
				mapGeojson(options.type);
			}
		}

		schema.post('save', self.mongoosePluginSave(schema, options));
		schema.post('remove', self.mongoosePluginRemove(schema, options));
	};
};

ElasticMongoose.prototype.mongoosePluginSave = function(schema, options) {
	var self = this;

	return function (obj) {
		var fields = {};

		function getEmbeddedField(obj, key) {
			key = key.split('.');
			
			for (var i in key) {
				if (obj[key[i]])
					obj = obj[key[i]];
				else
					return null;
			}

			return obj;
		}

		for (var key in schema.paths) {
			var item = getEmbeddedField(obj, key);
			if (!item) continue;

			var elastic = schema.paths[key].options.elastic;
			if (elastic === true) {
				fields[key] = item;
			} else if (elastic === 'array') {
				for (var key2 in item) {
					fields[key2] = item[key2];
				}
			} else if (elastic === 'geojson') {
				if (!item.coordinates) continue;

				fields.location = {
					lat: item.coordinates[1],
		            lon: item.coordinates[0]
				}
			} else if (typeof elastic === 'function') {
				elastic(obj, fields);
			}
		}

		self.client.bulk({
			body: [
				{
					index:  {
						_index: options.index ? options.index : self.options.index,
						_type: options.type,
						_id: obj._id
					},
					refresh: true
				},
				fields
			]
		}, function (err, resp) {
			if (err) self.errorCallback('save operation failed', err);
			else if (!err) self.infoCallback('save operation succeed', resp);
		});
	};
};

ElasticMongoose.prototype.mongoosePluginRemove = function(schema, options) {
	var self = this;

	return function (obj) {
		self.client.bulk({
			body: [
				{
					delete:  {
						_index: options.index ? options.index : self.options.index,
						_type: options.type,
						_id: obj._id
					}
				}
			]
		}, function (err, resp) {
			if (err) self.errorCallback('delete operation failed', err);
			else if (!err) self.infoCallback('delete operation succeed', resp);
		});
	};
};

ElasticMongoose.prototype.debugCallback = function(msg, data) {
	if (['DEBUG'].indexOf(this.options.logLevel) !== -1)
		this.logger.log(msg, data);
};

ElasticMongoose.prototype.infoCallback = function(msg, data) {
	if (['INFO', 'DEBUG'].indexOf(this.options.logLevel) !== -1)
		this.logger.info(msg, data);
};

ElasticMongoose.prototype.warningCallback = function(msg, data) {
	if (['WARNING', 'INFO', 'DEBUG'].indexOf(this.options.logLevel) !== -1)
		this.logger.warn(msg, data);
};

ElasticMongoose.prototype.errorCallback = function(msg, data) {
	if (['ERROR', 'WARNING', 'INFO', 'DEBUG'].indexOf(this.options.logLevel) !== -1)
		this.logger.error(msg, data);
};

module.exports = exports = new ElasticMongoose();