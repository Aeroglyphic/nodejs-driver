"use strict";

const util = require('util');
const types = require('../types');
const utils = require('../utils.js');
const errors = require('../errors.js');

const doneIteratorObject = Object.freeze({ done: true });

/** @module policies/loadBalancing */
/**
 * Base class for Load Balancing Policies
 * @constructor
 */
function LoadBalancingPolicy() {

}

/**
 * Initializes the load balancing policy, called after the driver obtained the information of the cluster.
 * @param {Client} client
 * @param {HostMap} hosts
 * @param {Function} callback
 */
LoadBalancingPolicy.prototype.init = function (client, hosts, callback) {
  this.client = client;
  this.hosts = hosts;
  callback();
};

/**
 * Returns the distance assigned by this policy to the provided host.
 * @param {Host} host
 */
LoadBalancingPolicy.prototype.getDistance = function (host) {
  return types.distance.local;
};

/**
 * Returns an iterator with the hosts for a new query.
 * Each new query will call this method. The first host in the result will
 * then be used to perform the query.
 * @param {String} keyspace Name of currently logged keyspace at <code>Client</code> level.
 * @param {ExecutionOptions|null} executionOptions The information related to the execution of the request.
 * @param {Function} callback The function to be invoked with the error as first parameter and the host iterator as
 * second parameter.
 */
LoadBalancingPolicy.prototype.newQueryPlan = function (keyspace, executionOptions, callback) {
  callback(new Error('You must implement a query plan for the LoadBalancingPolicy class'));
};

/**
 * This policy yield nodes in a round-robin fashion.
 * @extends LoadBalancingPolicy
 * @constructor
 */
function RoundRobinPolicy() {
  this.index = 0;
}

util.inherits(RoundRobinPolicy, LoadBalancingPolicy);

/**
 * Returns an iterator with the hosts to be used as coordinator for a query.
 * @param {String} keyspace Name of currently logged keyspace at <code>Client</code> level.
 * @param {ExecutionOptions|null} executionOptions The information related to the execution of the request.
 * @param {Function} callback The function to be invoked with the error as first parameter and the host iterator as
 * second parameter.
 */
RoundRobinPolicy.prototype.newQueryPlan = function (keyspace, executionOptions, callback) {
  if (!this.hosts) {
    return callback(new Error('Load balancing policy not initialized'));
  }
  const hosts = this.hosts.values();
  const self = this;
  let counter = 0;

  let planIndex = self.index % hosts.length;
  self.index += 1;
  if (self.index >= utils.maxInt) {
    self.index = 0;
  }

  callback(null, {
    next: function () {
      if (++counter > hosts.length) {
        return doneIteratorObject;
      }
      return {value: hosts[planIndex++ % hosts.length], done: false};
    }
  });
};

/**
 * A data-center aware Round-robin load balancing policy.
 * This policy provides round-robin queries over the node of the local
 * data center. It also includes in the query plans returned a configurable
 * number of hosts in the remote data centers, but those are always tried
 * after the local nodes. In other words, this policy guarantees that no
 * host in a remote data center will be queried unless no host in the local
 * data center can be reached.
 * @param {?String} [localDc] local datacenter name.
 * @param {Number} [usedHostsPerRemoteDc] the number of host per remote datacenter that the policy will yield \
 * in a newQueryPlan after the local nodes.
 * @extends {LoadBalancingPolicy}
 * @constructor
 */
function DCAwareRoundRobinPolicy(localDc, usedHostsPerRemoteDc) {
  this.localDc = localDc;
  this.usedHostsPerRemoteDc = usedHostsPerRemoteDc || 0;
  this.index = 0;
  /** @type {Array} */
  this.localHostsArray = null;
  /** @type {Array} */
  this.remoteHostsArray = null;
}

util.inherits(DCAwareRoundRobinPolicy, LoadBalancingPolicy);

/**
 * Initializes the load balancing policy.
 * @param {Client} client
 * @param {HostMap} hosts
 * @param {Function} callback
 */
DCAwareRoundRobinPolicy.prototype.init = function (client, hosts, callback) {
  this.client = client;
  this.hosts = hosts;
  hosts.on('add', this._cleanHostCache.bind(this));
  hosts.on('remove', this._cleanHostCache.bind(this));
  if (!this.localDc) {
    //get the first alive local, it should be local on top
    const hostsArray = hosts.values();
    let dcHost;
    for (let i = 0; i < hostsArray.length; i++) {
      const h = hostsArray[i];
      if (h.datacenter) {
        this.localDc = h.datacenter;
        dcHost = h;
        break;
      }
    }
    //this should never happen but it does not hurt
    if (!this.localDc) {
      return callback(new errors.DriverInternalError('Local datacenter could not be determined'));
    }
    client.log('warning', 'No local Data Center was provided with DCAwareRoundRobinPolicy' +
      '.  Using discovered DC \'' + this.localDc + '\' from host ' + dcHost.address +
      '.  Future releases will require local DC to be specified.');
  }
  callback();
};

/**
 * Returns the distance depending on the datacenter.
 * @param {Host} host
 */
DCAwareRoundRobinPolicy.prototype.getDistance = function (host) {
  if (!host.datacenter) {
    return types.distance.ignored;
  }
  if (host.datacenter === this.localDc) {
    return types.distance.local;
  }
  return types.distance.remote;
};

DCAwareRoundRobinPolicy.prototype._cleanHostCache = function () {
  this.localHostsArray = null;
  this.remoteHostsArray = null;
};

DCAwareRoundRobinPolicy.prototype._sliceNodesByDc = function() {
  const hosts = this.hosts.values();
  if (this.remoteHostsArray) {
    //there were already calculated
    return;
  }
  //do a full lookup to cache the remote hosts by dc
  const remoteHostsByDc = {};
  this.localHostsArray = [];
  this.remoteHostsArray = [];
  hosts.forEach(function (h) {
    if (!h.datacenter) {
      //not a remote dc node
      return;
    }
    if (h.datacenter === this.localDc) {
      this.localHostsArray.push(h);
      return;
    }
    if (this.usedHostsPerRemoteDc === 0) {
      return;
    }
    let hostPerDc = remoteHostsByDc[h.datacenter];
    if (!hostPerDc) {
      remoteHostsByDc[h.datacenter] = hostPerDc = [];
    }
    if (hostPerDc.length < this.usedHostsPerRemoteDc) {
      hostPerDc.push(h);
      this.remoteHostsArray.push(h);
    }
  }, this);
};

/**
 * It returns an iterator that yields local nodes first and remotes nodes afterwards.
 * The amount of remote nodes returned will depend on the usedHostsPerRemoteDc
 * @param {String} keyspace Name of currently logged keyspace at <code>Client</code> level.
 * @param {ExecutionOptions|null} executionOptions The information related to the execution of the request.
 * @param {Function} callback The function to be invoked with the error as first parameter and the host iterator as
 * second parameter.
 */
DCAwareRoundRobinPolicy.prototype.newQueryPlan = function (keyspace, executionOptions, callback) {
  if (!this.hosts) {
    return callback(new Error('Load balancing policy not initialized'));
  }
  this.index += 1;
  if (this.index >= utils.maxInt) {
    this.index = 0;
  }
  this._sliceNodesByDc();
  // Use a local reference of hosts
  const localHostsArray = this.localHostsArray;
  const remoteHostsArray = this.remoteHostsArray;
  let planLocalIndex = this.index;
  let planRemoteIndex = this.index;
  let counter = 0;
  let remoteCounter = 0;
  callback(null, {
    next: function () {
      let host;
      if (counter++ < localHostsArray.length) {
        host = localHostsArray[planLocalIndex++ % localHostsArray.length];
        return { value: host, done: false };
      }
      if (remoteCounter++ < remoteHostsArray.length) {
        host = remoteHostsArray[planRemoteIndex++ % remoteHostsArray.length];
        return { value: host, done: false };
      }
      return doneIteratorObject;
    }
  });
};

/**
 * A wrapper load balancing policy that add token awareness to a child policy.
 * @param {LoadBalancingPolicy} childPolicy
 * @extends LoadBalancingPolicy
 * @constructor
 */
function TokenAwarePolicy (childPolicy) {
  if (!childPolicy) {
    throw new Error("You must specify a child load balancing policy");
  }
  this.childPolicy = childPolicy;
}

util.inherits(TokenAwarePolicy, LoadBalancingPolicy);

TokenAwarePolicy.prototype.init = function (client, hosts, callback) {
  this.client = client;
  this.hosts = hosts;
  this.childPolicy.init(client, hosts, callback);
};

TokenAwarePolicy.prototype.getDistance = function (host) {
  return this.childPolicy.getDistance(host);
};

/**
 * Returns the hosts to use for a new query.
 * The returned plan will return local replicas first, if replicas can be determined, followed by the plan of the
 * child policy.
 * @param {String} keyspace Name of currently logged keyspace at <code>Client</code> level.
 * @param {ExecutionOptions|null} executionOptions The information related to the execution of the request.
 * @param {Function} callback The function to be invoked with the error as first parameter and the host iterator as
 * second parameter.
 */
TokenAwarePolicy.prototype.newQueryPlan = function (keyspace, executionOptions, callback) {
  let routingKey;
  if (executionOptions) {
    routingKey = executionOptions.getRoutingKey();
    if (executionOptions.getKeyspace()) {
      keyspace = executionOptions.getKeyspace();
    }
  }
  let replicas;
  if (routingKey) {
    replicas = this.client.getReplicas(keyspace, routingKey);
  }
  if (!routingKey || !replicas) {
    return this.childPolicy.newQueryPlan(keyspace, executionOptions, callback);
  }
  const iterator = new TokenAwareIterator(keyspace, executionOptions, replicas, this.childPolicy);
  iterator.iterate(callback);
};

/**
 * An iterator that holds the context for the subsequent next() calls
 * @param {String} keyspace
 * @param {ExecutionOptions} execOptions
 * @param {Array} replicas
 * @param childPolicy
 * @constructor
 * @ignore
 */
function TokenAwareIterator(keyspace, execOptions, replicas, childPolicy) {
  this.keyspace = keyspace;
  this.childPolicy = childPolicy;
  this.options = execOptions;
  this.localReplicas = [];
  this.replicaIndex = 0;
  this.replicaMap = {};
  this.childIterator = null;
  // Memoize the local replicas
  // The amount of local replicas should be defined before start iterating, in order to select an
  // appropriate (pseudo random) startIndex
  for (let i = 0; i < replicas.length; i++) {
    const host = replicas[i];
    if (this.childPolicy.getDistance(host) !== types.distance.local) {
      continue;
    }
    this.replicaMap[host.address] = true;
    this.localReplicas.push(host);
  }
  // We use a PRNG to set the replica index
  // We only care about proportional fair scheduling between replicas of a given token
  // Math.random() has an extremely short permutation cycle length but we don't care about collisions
  this.startIndex = Math.floor(Math.random() * this.localReplicas.length);
}

TokenAwareIterator.prototype.iterate = function (callback) {
  //Load the child policy hosts
  const self = this;
  this.childPolicy.newQueryPlan(this.keyspace, this.options, function (err, iterator) {
    if (err) {
      return callback(err);
    }
    //get the iterator of the child policy in case is needed
    self.childIterator = iterator;
    callback(null, {
      next: function () { return self.computeNext(); }
    });
  });
};

TokenAwareIterator.prototype.computeNext = function () {
  let host;
  if (this.replicaIndex < this.localReplicas.length) {
    host = this.localReplicas[(this.startIndex + (this.replicaIndex++)) % this.localReplicas.length];
    return { value: host, done: false };
  }
  // Return hosts from child policy
  let item;
  while ((item = this.childIterator.next()) && !item.done) {
    if (this.replicaMap[item.value.address]) {
      // Avoid yielding local replicas from the child load balancing policy query plan
      continue;
    }
    return item;
  }
  return doneIteratorObject;
};

/**
 * Create a new policy that wraps the provided child policy but only "allow" hosts
 * from the provided while list.
 * @class
 * @classdesc
 * A load balancing policy wrapper that ensure that only hosts from a provided
 * white list will ever be returned.
 * <p>
 * This policy wraps another load balancing policy and will delegate the choice
 * of hosts to the wrapped policy with the exception that only hosts contained
 * in the white list provided when constructing this policy will ever be
 * returned. Any host not in the while list will be considered ignored
 * and thus will not be connected to.
 * <p>
 * This policy can be useful to ensure that the driver only connects to a
 * predefined set of hosts. Keep in mind however that this policy defeats
 * somewhat the host auto-detection of the driver. As such, this policy is only
 * useful in a few special cases or for testing, but is not optimal in general.
 * If all you want to do is limiting connections to hosts of the local
 * data-center then you should use DCAwareRoundRobinPolicy and *not* this policy
 * in particular.
 * @param {LoadBalancingPolicy} childPolicy the wrapped policy.
 * @param {Array.<string>}  whiteList the white listed hosts address in the format ipAddress:port.
 * Only hosts from this list may get connected
 * to (whether they will get connected to or not depends on the child policy).
 * @extends LoadBalancingPolicy
 * @constructor
 */
function WhiteListPolicy (childPolicy, whiteList) {
  if (!childPolicy) {
    throw new Error("You must specify a child load balancing policy");
  }
  if (!util.isArray(whiteList)) {
    throw new Error("You must provide the white list of host addresses");
  }
  this.childPolicy = childPolicy;
  const map = {};
  whiteList.forEach(function (address) {
    map[address] = true;
  });
  this.whiteList = map;
}

util.inherits(WhiteListPolicy, LoadBalancingPolicy);

WhiteListPolicy.prototype.init = function (client, hosts, callback) {
  this.childPolicy.init(client, hosts, callback);
};

/**
 * Uses the child policy to return the distance to the host if included in the white list.
 * Any host not in the while list will be considered ignored.
 * @param host
 */
WhiteListPolicy.prototype.getDistance = function (host) {
  if (!this._contains(host)) {
    return types.distance.ignored;
  }
  return this.childPolicy.getDistance(host);
};

/**
 * @param {Host} host
 * @returns {boolean}
 * @private
 */
WhiteListPolicy.prototype._contains = function (host) {
  return !!this.whiteList[host.address];
};

/**
 * Returns the hosts to use for a new query filtered by the white list.
 */
WhiteListPolicy.prototype.newQueryPlan = function (keyspace, info, callback) {
  const self = this;
  this.childPolicy.newQueryPlan(keyspace, info, function (err, iterator) {
    if (err) {
      return callback(err);
    }
    callback(null, self._filter(iterator));
  });
};

WhiteListPolicy.prototype._filter = function (childIterator) {
  const self = this;
  return {
    next: function () {
      const item = childIterator.next();
      if (!item.done && !self._contains(item.value)) {
        return this.next();
      }
      return item;
    }
  };
};


exports.DCAwareRoundRobinPolicy = DCAwareRoundRobinPolicy;
exports.LoadBalancingPolicy = LoadBalancingPolicy;
exports.RoundRobinPolicy = RoundRobinPolicy;
exports.TokenAwarePolicy = TokenAwarePolicy;
exports.WhiteListPolicy = WhiteListPolicy;