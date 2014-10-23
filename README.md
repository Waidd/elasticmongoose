# elasticgoose

Just a simple [mongoose](http://mongoosejs.com/) plugin for [elasticsearch](http://www.elasticsearch.org/) indexing, based on [elasticsearch.js](http://www.elasticsearch.org/guide/en/elasticsearch/client/javascript-api/current/index.html).

## Notes

This was originally forked https://github.com/Waidd/elasticmongoose. It didn't seem to be in active development. It was a library we becoming dependant on at ClaraStream. Please note this is not production ready yet, and won't be until it reaches version 1.0.

Immediate TODOs: 
* Update the README usage docs
* Update the config object to include timeout settings
* Make all methods asynchronous, using async library for flow control 
* Write unit tests around all methods
* Figure out how to keep deletions from MongoDB in sync with ElasticSearch



## Installation

```bash
npm install --save elasticgoose
```

Or add it to your package.json

## Usage

### Initialization

First, you have to initialize the plugin with the connect method.

```javascript
var elasticgoose = require('elasticgoose');

elasticgoose.connect(function(err) {
	if (err) console.log('elasticsearch cluster down');
});
```

This call just initializes a client and pings the elasticsearch cluster to check if it is online. The default host will be `localhost:9200`. You can override options this way :

```javascript
var elasticgoose = require('elasticgoose');

var options = {
  host : 'host.com:4242'
};

elasticgoose.connect(function(err) {
  if (err) console.log('elasticsearch cluster down');
}, options);
```

Here is the list of options that you can specify :
* `index` : Default index for elasticsearch, initially set to `elasticgoose`.
* `findMethod` : Default methods to get object from mongoose, more details in the search section.

### Log

The plugin use [winston](https://github.com/flatiron/winston) to output log. The destination file is `elasticgoose.log`.

### Add elasticgoose to a Schema

```javascript
var mongoose = require('mongoose');
var Schema = mongoose.Schema;
var elasticgoose = require('elasticgoose');

var Something = new Schema({
  title : {
    type : String,
    elastic : true
  },
  description : {
    type : String,
    elastic : true
  },
  content : {
    type : String
  }
}
});

Something.plugin(elasticgoose.mongoosePlugin(), 'something');
module.exports = mongoose.model('something', Something);
```

Set the fields that you want to see indexed with `elastic : true`.
The second argument to specify to the `Plugin` is the options object.
If you have chosen a default index in the initialization part, you just have to give the name of the type, which NEEDS to be the same as the schema name (it's necessary for the search). Otherwise you have to give the index too :

```javascript
Something.plugin(elasticgoose.mongoosePlugin(), {
  index : 'someindex',
  type : 'something'
});
```
Then mongoose will be automatically indexed, updated, deleted in elasticsearch while your are manipulating the mongoose object.

#### Nested object

The plugin will automatically detect nested object(s) : 

```javascript
var nestedthing = {
  city : {
    type : String,
    elastic : true //will be indexed    
  }
};

var Something = new Schema({
  title : {
    type : String,
    elastic : true
  },
  description : {
    type : String,
    elastic : true
  },
  content : {
    type : String
  },
  thing : nestedthing
}
});
```
Nested data will be stored at the first level of the elastic object. So the object in elastic will look like :

```javascript
{
  'title' : '...',
  'description' : '...',
  'city' : '...'
}
```

#### `array` type

If you have to deal with a `Types.Mixed`, for example, to manipulate a osm address, you can use the `array` type :

```javascript
//the mongoose schema
var SomeWhere = new Schema({
  title : {
    type : String,
    elastic : true
  },
  description : {
    type : String
  },
  address : {
    type : Types.Mixed
    elastic : 'array'
  }
});

//the mongodb object will look like
{
  title: 'somewhere',
  description: 'est sequi et cupiditate corrupti et porro nomnis...',
  address : {
    continent: 'European Union',
    country_code: 'fr',
    country: 'France',
    postcode: '...',
    state: '...',
    county: '...',
    city: '...',
    pedestrian: '...',
    house_number: '...'
  }
}

//and the elastic object
{
  title: 'somewhere',
  continent: 'European Union',
  country_code: 'fr',
  country: 'France',
  postcode: '...',
  state: '...',
  county: '...',
  city: '...',
  pedestrian: '...',
  house_number: '...'
}
```

#### `function` type

You can give a function instead of a type. This function will be called during the indexation of the object.

```javascript
var Something = new Schema({
  title : {
    type : String,
    elastic : true
  },
  content : {
    type : String,
    elastic : function(obj, fields) {
      if (obj.indexContent)
        fields.content = obj.content.substr(0, 100);
    }
  },
  indexContent : {
    type : Boolean,
    'default' : false
  }
});
````

The function takes 2 parameters :
* `obj` : the mongo object
* `fields` : the indexed fields

#### `geojson` type

You can deal with `geojson` type to perform localised search.

```javascript
var Somewhere = new Schema({
  title : {
    type : String,
    elastic : true
  },
  loc : {
    type : String,
    elastic : 'geojson'
  },
});
```

### Search

```javascript
var elasticgoose = require('elasticgoose');

elasticgoose.search(options, query, function(err, resp){
  if(err){
    res.error(err);
  } else {
    res.json(resp);
  }
});
```

The options are defined by the type and the index. But once more, if you have specified a default index in the initialization part, you do not have to give it again. The type can be unique or an array of types.

```javascript
options = {
  type : 'something'
}
```
```javascript
options = {
  type : ['something', 'somewhere'],
  index : 'someindex'
}
```

You can specify your request by using the [Elastic Search Query DSL](http://www.elasticsearch.org/guide/en/elasticsearch/reference/current/query-dsl-queries.html).

Some examples :

```javascript
query = {
  match : {
    title : 'Lorem ipsum dolor sit amet, consectetur adipiscing elit.',
    description: 'Etiam at mauris tristique, adipiscing enim a, malesuada nisi.'
  }
};
```
```javascript
query = {
  multi_match : {
    query: 'Lorem ipsum dolor sit amet, consectetur adipiscing elit.',
    fields: ['title', 'description']
  }
};
//the multi_match work with fields from different type
```
```javascript
query = {
  filtered : {
    multi_match : {},
    filter : {
      distance : '10km',
      location : {
        lat : '45.439417',
        lon : '12.328865'
      }
    }
  }
};
```

elasticgoose will return an array of mongo objects. So it's easier to manipulate. The plugin will use the default `findMethod` to get the objects from mongo : 

```javascript
  findMethod(model, data, callback){
    model.findOne({ '_id': data._id}, function(err, instance) {
      callback(err, instance);
    });
  }
```

You can't overwrite it during the initialization or give a specific method for a type defining a `elasticFind` method to the schema. 

```javascript
Something.methods.elasticFind = function(model, data, callback, options){
  //options come from the fourth argument of the search method.
  model.findOne({
      '_id': data._id,
      //do some tricky conditions with the options
    })
    //populate some fields or whatever
    .populate('somefield')
    .exec(function(err, instance){
      callback(err, instance);
    });
};

Something.plugin(elasticgoose.mongoosePlugin(), 'event');

//then
elasticgoose.search(options, query, function(err, resp){
  if(err){
    res.error(err);
  } else {
    res.json(resp);
  }
}, options);
```
If an object is still in elastic but not anymore in mongodb, the plugin will log an error with `errorCallback` and keep a normal behaviour. This kind of probrem can happen if the cluster is down for a while.

## Truncate an index

If you need to truncate an elasticsearch index (during unit tests for example), you can use the `truncate` method :

```javascript
  elasticgoose.truncate(function(err){
    done(err);
  }, {
    index : 'someindex'
  });
```

As usual, if you specified an index during the initialization, you do not have to give any options.

## Refresh an index

If you need to manually refresh an elasticsearch index (also during some unit tests), you can use the `refresh` method :

```javascript
  elasticgoose.refresh(function(err){
    done (err);
  }, {
    index : 'someindex'
  });
```

Same options management than `truncate`. 

## License

The MIT License (MIT)

Copyright (c) 2014 Thomas Cholley

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.