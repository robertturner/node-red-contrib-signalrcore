/**
 * Copyright JS Foundation and other contributors, http://js.foundation
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 **/

module.exports = function (RED) {
  "use strict";
  const signalR = require("@microsoft/signalr");
  var inspect = require("util").inspect;

  // =======================
  // === SignalR Configuration/Connection node ===
  // =======================
  function SignalRClientNode(n) {
    // Create a RED node
    RED.nodes.createNode(this, n);
    var node = this;

    // Local copies of the node configuration (as defined in the .html)
    node.host = n.host;
    node.port = n.port;
    node.hub = n.hub;
    node.secure = n.secure;
    node.reconnectInterval = parseInt(n.reconnectInterval);
    if (node.reconnectInterval < 100) node.reconnectInterval = 100;
    var portLabel = node.port === '80' ? '' : ':' + node.port;
    if (node.secure) portLabel = node.port === '443' ? '' : ':' + node.port;
    node.path = `${node.secure ? 'https://' : 'http://'}${node.host}${portLabel}/${node.hub}`;

    node.closing = false; // Used to check if node-red is closing, or not, and if so decline any reconnect attempts.

    // Connect to remote endpoint
    function startconn() {
      node.closing = false;
      if (node.reconnectTimoutHandle) clearTimeout(node.reconnectTimoutHandle);
      node.reconnectTimoutHandle = null;
      var connection = new signalR.HubConnectionBuilder()
        .withUrl(node.path)
        .configureLogging(signalR.LogLevel.Information)
        .build();
      node.connection = connection; // keep for closing
      handleConnection(connection);
    }

    async function handleConnection( /*connection*/ connection) {
      var id = '';

      function notifyOnError(err) {
        if (!err) return;
        node.emit('erro', {
          err: err,
          id: id
        });
      }

      function reconnect() {
        if (node.reconnectTimoutHandle) clearTimeout(node.reconnectTimoutHandle);
        if (node.closing) return;
        node.reconnectTimoutHandle = setTimeout(() => startconn(), node.reconnectInterval);
      }

      try {
        await connection.start();
        // We're connected
        id = connection.connectionId;
        node.emit('opened', {
          count: '',
          id: id
        });

        connection.onclose(err => {
          node.emit('closed', {
            count: '',
            id: id
          });
          notifyOnError(err);
          reconnect();
        });
      } catch (err) {
        notifyOnError(err);
        reconnect();
      }
    }

    node.closing = false;
    startconn(); // start outbound connection

    node.on("close", function () {
      node.closing = true;
      node.connection.stop();
      if (node.reconnectTimoutHandle) {
        clearTimeout(node.reconnectTimoutHandle);
        node.reconnectTimoutHandle = null;
      }
    });
  }
  RED.nodes.registerType("signalr-client", SignalRClientNode);

  // =======================
  // === SignalR In node ===
  // =======================
  function SignalRInNode(n) {
    RED.nodes.createNode(this, n);
    var node = this;
    node.client = n.client;
    node.responses = n.responses;
    node.connectionConfig = RED.nodes.getNode(this.client);
    if (!this.connectionConfig) {
      this.error(RED._("signalr.errors.missing-conf"));
      return;
    }
    this.connectionConfig.on('opened', function (event) {
      node.status({
        fill: "green",
        shape: "dot",
        text: RED._("signalr.status.connected", {
          count: event.count
        }),
        event: "connect",
        _session: {
          type: "signalr",
          id: event.id
        }
      });
      // send the connected msg
      node.send([{ _connectionId: event.id, payload: "Connected" }, null, null]);
      node.responses.forEach((response, index) => {
        // subscribe to each methodName in configured responses
        node.connectionConfig.connection.on(response.methodName, (data) => {
          // we're in a callback from the server
          var newMsg = {
            payload: data
          };
          var knownMsgs = [null, null, null]; // make room for connected, errors, and disconnected
          for (let outputNumber = 0; outputNumber < node.responses.length; outputNumber++) {
            if (outputNumber === index) {
              // this is our msg output
              knownMsgs.push(newMsg);
            } else {
              knownMsgs.push(null);
            };
          }
          node.send(knownMsgs);
        });
      });
    });
    this.connectionConfig.on('erro', function (event) {
      node.status({
        fill: "red",
        shape: "ring",
        text: RED._("node-red:common.status.error"),
        event: "error",
        _session: {
          type: "signalr",
          id: event.id
        }
      });
      var errMsg = { payload: event.err };
      if (event.id) errMsg._connectionId = event.id;
      node.send([null, errMsg, null]);
    });
    this.connectionConfig.on('closed', function (event) {
      var status;
      if (event.count > 0) {
        status = {
          fill: "green",
          shape: "dot",
          text: RED._("signalr.status.connected", {
            count: event.count
          })
        };
      } else {
        status = {
          fill: "red",
          shape: "ring",
          text: RED._("node-red:common.status.disconnected")
        };
      }
      status.event = "disconnect";
      status._session = {
        type: "signalr",
        id: event.id
      }
      node.status(status);
      node.send([null, null, { _connectionId: event.id, payload: "Disconnected" }]);
    });
    this.on('close', function (removed, done) {
      if (removed && node.connectionConfig) {
        node.connectionConfig.removeInputNode(node);
      } else {
        // This node is being restarted
      }
      node.status({});
      if (done) done();
    });
  }
  RED.nodes.registerType("signalr in", SignalRInNode);

  // =======================
  // === SignalR Out node ===
  // =======================
  function SignalROutNode(n) {
    RED.nodes.createNode(this, n);
    var node = this;
    node.client = n.client;
    node.connectionConfig = RED.nodes.getNode(this.client);
    if (!node.connectionConfig) {
      this.error(RED._("signalr.errors.missing-conf"));
      return
    }
    node.connectionConfig.on('opened', function (event) {
      node.status({
        fill: "green",
        shape: "dot",
        text: RED._("signalr.status.connected", {
          count: event.count
        }),
        event: "connect",
        _session: {
          type: "signalr",
          id: event.id
        }
      });
    });
    node.connectionConfig.on('erro', function (event) {
      node.status({
        fill: "red",
        shape: "ring",
        text: RED._("node-red:common.status.error"),
        event: "error",
        _session: {
          type: "signalr",
          id: event.id
        }
      })
    });
    node.connectionConfig.on('closed', function (event) {
      var status;
      if (event.count > 0) {
        status = {
          fill: "green",
          shape: "dot",
          text: RED._("signalr.status.connected", {
            count: event.count
          })
        };
      } else {
        status = {
          fill: "red",
          shape: "ring",
          text: RED._("node-red:common.status.disconnected")
        };
      }
      status.event = "disconnect";
      status._session = {
        type: "signalr",
        id: event.id
      }
      node.status(status);
    });
    node.on("input", function (msg, nodeSend, nodeDone) {
      var methodName = msg.topic;
      var payload = msg.payload;
      var connectionConfig = node.connectionConfig;
      if (!connectionConfig) {
        node.error('Unable to find connection configuration');
        if (nodeDone) nodeDone();
        return;
      }
      if (!methodName) {
        node.error('Missing msg.topic');
        if (nodeDone) nodeDone();
        return;
      }
      if (!payload) {
        node.error('Missing msg.payload');
        if (nodeDone) nodeDone();
        return;
      }
      if (!Array.isArray(payload)) {
        node.error('msg.payload must be an array');
        if (nodeDone) nodeDone();
        return;
      }
      var replyPromise = connectionConfig.connection.invoke(methodName, ...payload);
	  replyPromise.then((replyData) =>
		{
			node.send([{ payload: replyData }]);
			if (nodeDone) nodeDone();
		})
		.catch(err =>
		{
			if (nodeDone) nodeDone();
		});
      
    });
    node.on('close', function (done) {
      node.status({});
      if (done) done();
    });
  }
  RED.nodes.registerType("signalr out", SignalROutNode);
}