'use strict';

var	elasticSearch = require('elasticsearch'),
	mongoose = require('mongoose'),
	_ = require('underscore'),
	Q = require('q');

function ElasticMongoose() {
	this.client = null;
	this.options = {
		host: 'localhost:9200',
		index: 'elasticmongoose',
		successCallback: function(resp) {
			console.log('[elastic] operation success :', resp);
		},
		errorCallback: function(err) {
			console.log('[elastic] an error occured :', err);
		},
		findMethod: function(model, data, callback){
			model.findOne({ '_id': data._id}, function(err, instance) {
				callback(err, instance);
			});
		}
	};
}

ElasticMongoose.prototype.connect = function(callback, options) {
	this.options = _.defaults({}, options || {}, this.options);

	this.client = new elasticSearch.Client({
		host: options.host,
		log: options.log
	});

	this.client.ping({
		requestTimeout: 1000,
		hello: 'elasticsearch!'
	}, function (err) {
		callback(err);
	});
};

ElasticMongoose.prototype.truncate = function(callback, options) {
	options = options || {};
	options.index = options.index || this.options.index;

	this.client.deleteByQuery({
		index: options.index,
		type: '*',
		q: '*'
	}, function(err, res) {
		console.log(err, res);
		callback(err);
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
			body: {query: options.query}
		}, function(err, resp) {
			if(err) deferred.reject(err);
			else deferred.resolve(resp.hits);
		});

		return deferred.promise;
	}).then(function(resp) {
		var deferred = Q.defer();

		if (resp.total === 0) {
			deferred.resolve([]);
			return deferred.promise;
		}

		var modelNames = mongoose.modelNames();
		var data = [];
		var after = _.after(resp.total, function() {
			deferred.resolve(data);
		});

		resp.hits.forEach(function(value) {
			if (_.indexOf(modelNames, value._type) === -1) {
				self.errorCallback('search: model is not defined');
				return;
			}

			var model = mongoose.model(value._type);
			var findMethod = model.schema.methods.elasticFind ? model.schema.methods.elasticFind : self.options.findMethod;

			findMethod(model, value, function(err, instance) {
				if (err) {
					deferred.reject(err);
				} else if (!instance) {
					self.errorCallback('search: instance of model not found');
				} else {
					data.push(instance);
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

	return function(schema, options) {
		options = (typeof options === 'string') ? {type: options} : options;

		schema.post('save', self.mongoosePluginSave(schema, options));
		schema.post('remove', self.mongoosePluginRemove(schema, options));
	};
};

ElasticMongoose.prototype.mongoosePluginSave = function(schema, options) {
	var self = this;

	return function (obj) {
		var fields = {};
		for(var key in schema.tree) {
			if (schema.tree[key].elastic) {
				fields[key] = obj[key];
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
			if (err) self.errorCallback(err);
			else if (!err) self.successCallback(resp);
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
			if (err) self.errorCallback(err);
			else if (!err) self.successCallback(resp);
		});
	};
};

ElasticMongoose.prototype.successCallback = function(resp) {
	if (this.options.successCallback) {
		this.options.successCallback(resp);
	}
};

ElasticMongoose.prototype.errorCallback = function(err) {
	if (this.options.errorCallback) {
		this.options.errorCallback(err);
	}
};

module.exports = exports = new ElasticMongoose();