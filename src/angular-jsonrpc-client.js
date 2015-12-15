(function() {
  'use strict';

  var jsonrpcModule = angular.module('angular-jsonrpc-client', []);

  jsonrpcModule.service('jsonrpc', jsonrpc);
  jsonrpcModule.provider('jsonrpcConfig', jsonrpcConfig);

  jsonrpc.$inject = ['$q', '$http', 'jsonrpcConfig'];

  var id = 0;
  var ERROR_TYPE_SERVER = 'JsonRpcServerError';
  var ERROR_TYPE_TRANSPORT = 'JsonRpcTransportError';
  var ERROR_TYPE_CONFIG = 'JsonRpcConfigError';
  var DEFAULT_SERVER_NAME = 'main';

  function JsonRpcTransportError(error) {
      this.name = ERROR_TYPE_TRANSPORT;
      this.message = error;
  }
  JsonRpcTransportError.prototype = Error.prototype;  

  function JsonRpcServerError(error) {
      this.name    = ERROR_TYPE_SERVER;
      this.message = error.message;
      this.error   = error;
      this.data    = error.data;
  }
  JsonRpcServerError.prototype = Error.prototype;  

  function JsonRpcConfigError(error) {
      this.name = ERROR_TYPE_CONFIG;
      this.message = error;
  }
  JsonRpcConfigError.prototype = Error.prototype;  

  function jsonrpc($q, $http, jsonrpcConfig) {
    return {
      request              : request,
      ERROR_TYPE_SERVER    : ERROR_TYPE_SERVER,
      ERROR_TYPE_TRANSPORT : ERROR_TYPE_TRANSPORT,
      ERROR_TYPE_CONFIG    : ERROR_TYPE_CONFIG,
      JsonRpcTransportError: JsonRpcTransportError,
      JsonRpcServerError   : JsonRpcServerError,
      JsonRpcConfigError   : JsonRpcConfigError
    };

    function _getInputData(methodName, args) {
      id += 1;
      return {
        jsonrpc: '2.0',
        id     : id,
        method : methodName,
        params : args
      }
    }

    function _findServer(serverName) {
      var servers = jsonrpcConfig.servers.filter(function(s) { return s.name === serverName; });
      return servers.length > 0 ? servers[0] : null;
    }

    function _determineArguments(args) {
      if (args.length === 2) {
        return {
          serverName: DEFAULT_SERVER_NAME,
          methodName: args[0],
          methodArgs: args[1],
        };
      }
      else {
        return {
          serverName: args[0],
          methodName: args[1],
          methodArgs: args[2],
        };
      }
    }

    function _determineErrorDetails(data, status, url) {
      // 2. Call was received by the server. Server returned an error.
      // 3. Call did not arrive at the server.
      var errorType = ERROR_TYPE_TRANSPORT;
      var errorMessage;

      if (status === 0) {
        // Situation 3
        errorMessage = 'Connection refused at ' + url;
      }
      else if (status === 404) {
        // Situation 3
        errorMessage = '404 not found at ' + url;
      }
      else if (status === 500) {
        // This could be either 2 or 3. We have to look at the returned data
        // to determine which one.
        if (data.jsonrpc && data.jsonrpc === '2.0') {
          // Situation 2
          errorType = ERROR_TYPE_SERVER;
          errorMessage = data.error;
        }
        else {
          // Situation 3
          errorMessage = '500 internal server error at ' + url + ': ' + data;
        }
      }
      else {
        // Situation 3
        errorMessage = 'Unknown error. HTTP status: ' + status + ', data: ' + data;
      }

      return {
        type   : errorType,
        message: errorMessage,
      };
    }

    function request(arg1, arg2, arg3) {
      var args = _determineArguments(arguments);

      var deferred = $q.defer();

      if (jsonrpcConfig.servers.length === 0) {
        deferred.reject(new JsonRpcConfigError('Please configure the jsonrpc client first.'));
        return deferred.promise;
      }

      var server = _findServer(args.serverName);

      if (!server) {
        deferred.reject(new JsonRpcConfigError('Server "' + args.serverName + '" has not been configured.'));
        return deferred.promise;
      }

      var inputData = _getInputData(args.methodName, args.methodArgs);
      var headers = angular.extend(
        server.headers,
        {
           'Content-Type': 'application/json',
        }
      );

      var req = {
       method : 'POST',
       url    : server.url,
       headers: headers,
       data   : inputData
      };

      var promise = $http(req);

      if (jsonrpcConfig.returnHttpPromise) {
        return promise;
      }

      // Here, we determine which situation we are in:
      // 1. Call was a success.
      // 2. Call was received by the server. Server returned an error.
      // 3. Call did not arrive at the server.
      // 
      // 2 is a JsonRpcServerError, 3 is a JsonRpcTransportError.
      // 
      // We are assuming that the server can use either 200 or 500 as
      // http return code in situation 2. That depends on the server
      // implementation and is not determined by the JSON-RPC spec.
      promise.success(function(data, status, headers, config) {
        if (data.result) {
          // Situation 1
          deferred.resolve(data.result);
        }
        else {
          // Situation 2
          deferred.reject(new JsonRpcServerError(data.error));
        }
      })
      .error(function(data, status, headers, config) {
        // Situation 2 or 3.
        var errorDetails = _determineErrorDetails(data, status, server.url);

        if (errorDetails.type === ERROR_TYPE_TRANSPORT) {
          deferred.reject(new JsonRpcTransportError(errorDetails.message));
        }
        else {
          deferred.reject(new JsonRpcServerError(errorDetails.message));
        }
      });

      return deferred.promise;
    }    
  }

  function jsonrpcConfig() {
    var config = {
      servers: [],
      returnHttpPromise: false
    };

    this.set = function(args) {
      if (typeof(args) !== 'object') {
        throw new Error('Argument of "set" must be an object.');
      }

      var allowedKeys = ['url', 'servers', 'returnHttpPromise'];
      var keys = Object.keys(args);
      keys.forEach(function(key) {
        if (allowedKeys.indexOf(key) < 0) {
          throw new JsonRpcConfigError('Invalid configuration key "' + key + '". Allowed keys are: ' +
            allowedKeys.join(', '));
        }
        
        if (key === 'url') {
          config.servers = [{
            name: DEFAULT_SERVER_NAME,
            url: args[key],
            headers: {}
          }];
        }
        else if (key === 'servers') {
          config.servers = getServers(args[key]);
        }
        else {
          config[key] = args[key];
        }
      });
    };

    function getServers(data) {
      if (!(data instanceof Array)) {
        throw new JsonRpcConfigError('Argument "servers" must be an array.');
      }
      var servers = [];

      data.forEach(function(d) {
        if (!d.name) {
          throw new JsonRpcConfigError('Item in "servers" argument must contain "name" field.');
        }
        if (!d.url) {
          throw new JsonRpcConfigError('Item in "servers" argument must contain "url" field.');
        }
        var server = {
          name: d.name,
          url: d.url,
        };
        if (d.hasOwnProperty('headers')) {
          server.headers = d.headers;
        }
        else {
          server.headers = {};
        }
        servers.push(server);
      });

      return servers;
    }

    this.$get = function() {
      return config;
    };
  }
}).call(this);
