const { t } = require('i18next');
const WebSocket = require('ws');  // 添加 ws 模块引用

module.exports = function (RED) {
    // FUXA服务器配置节点
    function FuxaServerNode(config) {
        RED.nodes.createNode(this, config);
        this.name = config.name;
        this.serverUrl = config.serverUrl;
    }

    function FuxaConnect(config, node) {
        // 重连相关配置
        const reconnectConfig = {
            attempts: 0,
            maxAttempts: 5,
            delay: 5000,  // 5秒
            timer: null
        };

        // 重连函数
        function reconnect() {
            if (reconnectConfig.attempts >= reconnectConfig.maxAttempts) {
                node.error('重连次数超过最大限制，停止重连');
                node.status({fill:"red", shape:"dot", text:`重连失败(${reconnectConfig.attempts}次)`});
                return;
            }

            reconnectConfig.attempts++;
            node.status({fill:"yellow", shape:"ring", text:`正在重连(${reconnectConfig.attempts}次)`});
            node.log(`尝试第 ${reconnectConfig.attempts} 次重连...`);

            // 清除之前的定时器
            if (reconnectConfig.timer) {
                clearTimeout(reconnectConfig.timer);
            }

            // 延迟重连
            reconnectConfig.timer = setTimeout(() => {
                initConnection();
            }, reconnectConfig.delay);
        }

        // 初始化连接
        function initConnection() {
            node.log('正在连接到FUXA服务器...');

            // 构建socket.io连接URL
            const socketUrl = `${config.server.serverUrl}/socket.io/?token=null&EIO=3&transport=polling&t=PNLV_ls`;
            
            fetch(socketUrl)
                .then(response => {
                    if (!response.ok) throw new Error('连接失败');
                    return response.text();
                })
                .then(data => {
                    node.log('连接成功，服务器响应: ' + data);

                    // 解析响应数据
                    try {
                        // 提取JSON部分
                        const match = data.match(/\d+:\d+({.*})\d*:\d*/);
                        if (!match || !match[1]) {
                            throw new Error('无效的响应格式');
                        }

                        const jsonStr = match[1];
                        node.log('提取的JSON数据: ' + jsonStr);

                        const jsonData = JSON.parse(jsonStr);
                        const sid = jsonData.sid;

                        // 构建WebSocket URL
                        const wsUrl = config.server.serverUrl.replace('http', 'ws') +
                            `/socket.io/?token=null&EIO=3&transport=websocket&sid=${sid}`;

                        node.log('正在建立WebSocket连接: ' + wsUrl);

                        // 创建WebSocket连接
                        const ws = new WebSocket(wsUrl);

                        ws.on('open', function () {
                            node.log('WebSocket连接已建立');
                            node.status({ fill: "green", shape: "dot", text: "WebSocket已连接" });
                            // 保存WebSocket实例以便后续使用
                            node.server.ws = ws;
                            ws.send("2probe");
                            
                            // 连接成功，重置重连计数
                            reconnectConfig.attempts = 0;

                            // 添加心跳定时器
                            node.heartbeatTimer = setInterval(function() {
                                try {
                                    if (ws.readyState === WebSocket.OPEN) {
                                        ws.send("2");
                                    } else {
                                        clearInterval(node.heartbeatTimer);
                                        reconnect();  // 心跳失败时触发重连
                                    }
                                } catch (error) {
                                    clearInterval(node.heartbeatTimer);
                                    reconnect();  // 发送心跳异常时触发重连
                                }
                            }, 20000); // 20秒发送一次
                        });

                        ws.on('message', function (msg) {
                            //node.log('收到WebSocket消息: ' + msg.toString());
                            // 如果是心跳包，不处理
                            var data = msg.toString();
                            if (data == ("3probe")) {
                                ws.send("5");
                            }
                            if (data === "2" || data === "3probe" || data === "3") {
                                return;
                            }
                            node.fuxa_cb(data);
                        });

                        ws.on('error', function (error) {
                            node.error('WebSocket错误: ' + error.message);
                            node.status({ fill: "red", shape: "ring", text: "WebSocket错误" });
                        });

                        ws.on('close', function () {
                            node.log('WebSocket连接已关闭');
                            node.status({ fill: "yellow", shape: "ring", text: "WebSocket已断开" });
                            // 清除心跳定时器
                            if (node.heartbeatTimer) {
                                clearInterval(node.heartbeatTimer);
                                delete node.heartbeatTimer;
                            }
                            delete node.server.ws;
                            
                            // 触发重连
                            reconnect();
                        });

                    } catch (error) {
                        node.error('解析响应数据失败: ' + error.message);
                        node.status({ fill: "red", shape: "ring", text: "连接失败" });
                        reconnect();  // 解析失败时触发重连
                    }

                    // 记录配置信息
                    node.log('已连接到服务器: ' + config.server.serverUrl);
                    if (config.device) {
                        node.log('已选择设备: ' + config.device);
                    }
                    if (config.variable) {
                        node.log('已选择变量: ' + config.variable);
                    }
                })
                .catch(error => {
                    node.error('连接FUXA服务器失败: ' + error.message);
                    node.status({ fill: "red", shape: "ring", text: "连接失败" });
                    reconnect();  // 连接失败时触发重连
                });
        }

        // 开始首次连接
        initConnection();
    }

    // FUXA主节点
    function FuxaNode(config) {
        RED.nodes.createNode(this, config);
        var node = this;

        // 初始化日志
        node.log('FUXA节点初始化中...');
        node.status({ fill: "yellow", shape: "ring", text: "初始化中" });

        // 获取服务器配置节点
        this.server = RED.nodes.getNode(config.server);
        this.device = config.device;
        this.variable = config.variable;

        //DataCallBack
        this.fuxa_cb = function (param) {
            try {
                // 移除消息类型前缀（如果存在）
                const data = param.replace(/^\d+/, '');

                if (data) {
                    try {
                        // 尝试解析JSON数据
                        const jsonData = JSON.parse(data);
                        if (jsonData[0] = "device-values") {
                            if (jsonData[1].id === node.device) {
                                jsonData[1].values.forEach(e => {
                                    if (e.id === node.variable) {
                                        // 发送解析后的JSON对象
                                        node.send({
                                            topic: "fuxa",
                                            payload: e.tagref,
                                            raw: param
                                        });
                                    }
                                });
                            }

                        }
                    } catch (e) {
                        // 如果不是JSON，发送原始数据
                        node.send({
                            topic: "fuxa",
                            payload: data,
                            raw: param
                        });
                    }
                }
            } catch (error) {
                node.error("处理FUXA数据失败: " + error.message);
                node.send({
                    topic: "fuxa_error",
                    payload: error.message,
                    raw: param
                });
            }
        };

        if (this.server) {
            FuxaConnect(this, node);
        } else {
            node.status({ fill: "grey", shape: "dot", text: "FUXA未配置服务器" });
        }

        // 处理输入消息
        this.on('input', function (msg) {

            if (msg.topic != "fuxa" || msg.payload == null || msg.payload.value == undefined) {
                return;
            }

            node.log(JSON.stringify());




            var data = ["device-values", {
                cmd: "set",
                fnc: [null, msg.payload.value],
                var: {
                    id: this.variable,
                    source: this.device,
                    value: msg.payload.value,
                    timestamp: new Date().getTime()
                }
            }];
            if (this.server) {
                msg.serverUrl = this.server.serverUrl;
                msg.device = this.device;
                msg.variable = this.variable;
                node.log(JSON.stringify(data));
                node.server.ws.send("42" + JSON.stringify(data));
                // node.send(msg);
            }
        });

        // 节点关闭时的清理
        this.on('close', function () {
            // 清除心跳定时器
            if (node.heartbeatTimer) {
                clearInterval(node.heartbeatTimer);
                delete node.heartbeatTimer;
            }
            // 关闭WebSocket连接
            if (node.ws) {
                node.ws.close();
                delete node.ws;
            }
            node.log('FUXA节点关闭');
            node.status({});
        });
    }

    // 注册服务器配置节点
    RED.nodes.registerType("fuxa-server", FuxaServerNode, {
        defaults: {
            name: { value: "" },
            serverUrl: { value: "", required: true }
        },
        label: function () {
            return this.name || this.serverUrl;
        }
    });

    // 注册FUXA主节点
    RED.nodes.registerType("fuxa", FuxaNode, {
        defaults: {
            name: { value: "" },
            server: { type: "fuxa-server", required: true },
            device: { value: "" },
            variable: { value: "" }
        },
        category: 'FUXA',
        color: '#a6bbcf',
        inputs: 1,
        outputs: 1,
        icon: "file.png",
        label: function () {
            return this.name || "FUXA";
        }
    });
}
