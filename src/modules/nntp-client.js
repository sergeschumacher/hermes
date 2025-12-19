/**
 * NNTP Client Module
 * Implements NNTP protocol for usenet communication
 *
 * NNTP Response codes:
 * 200 - Server ready, posting allowed
 * 201 - Server ready, no posting
 * 211 - Group selected
 * 220 - Article retrieved
 * 222 - Article body follows
 * 281 - Authentication successful
 * 381 - More authentication required (password)
 * 411 - No such group
 * 420 - No current article
 * 430 - No such article
 * 480 - Authentication required
 * 481 - Authentication rejected
 * 500 - Command not recognized
 */

const net = require('net');
const tls = require('tls');
const { EventEmitter } = require('events');

// NNTP response codes
const RESPONSE_CODES = {
    SERVICE_AVAILABLE_POST: 200,
    SERVICE_AVAILABLE_NO_POST: 201,
    GROUP_SELECTED: 211,
    ARTICLE_HEAD_BODY: 220,
    ARTICLE_HEAD: 221,
    ARTICLE_BODY: 222,
    ARTICLE_STAT: 223,
    AUTH_ACCEPTED: 281,
    AUTH_CONTINUE: 381,
    NO_SUCH_GROUP: 411,
    NO_CURRENT_ARTICLE: 420,
    NO_SUCH_ARTICLE: 430,
    AUTH_REQUIRED: 480,
    AUTH_REJECTED: 481,
    COMMAND_UNKNOWN: 500
};

/**
 * NNTP Connection class
 * Manages a single connection to an NNTP server
 */
class NNTPConnection extends EventEmitter {
    constructor(options = {}) {
        super();
        this.host = options.host;
        this.port = options.port || 563;
        this.ssl = options.ssl !== false;
        this.username = options.username;
        this.password = options.password;
        this.timeout = options.timeout || 30000;

        this.socket = null;
        this.connected = false;
        this.authenticated = false;
        this.currentGroup = null;

        this._buffer = Buffer.alloc(0);
        this._responseQueue = [];
        this._currentResponse = null;
    }

    /**
     * Connect to the NNTP server
     */
    async connect() {
        return new Promise((resolve, reject) => {
            const connectOptions = {
                host: this.host,
                port: this.port,
                rejectUnauthorized: false
            };

            // Create socket
            if (this.ssl) {
                this.socket = tls.connect(connectOptions);
            } else {
                this.socket = net.connect(connectOptions);
            }

            // Set timeout
            this.socket.setTimeout(this.timeout);

            // Handle connection
            const onConnect = async () => {
                try {
                    // Wait for server greeting
                    const greeting = await this._waitForResponse();
                    if (greeting.code !== RESPONSE_CODES.SERVICE_AVAILABLE_POST &&
                        greeting.code !== RESPONSE_CODES.SERVICE_AVAILABLE_NO_POST) {
                        throw new Error(`Server rejected connection: ${greeting.message}`);
                    }

                    this.connected = true;

                    // Authenticate if credentials provided
                    if (this.username) {
                        await this._authenticate();
                    }

                    resolve();
                } catch (err) {
                    reject(err);
                }
            };

            this.socket.once('connect', onConnect);
            this.socket.once('secureConnect', onConnect);

            // Handle data
            this.socket.on('data', (data) => this._onData(data));

            // Handle errors
            this.socket.on('error', (err) => {
                this.emit('error', err);
                if (this._currentResponse) {
                    this._currentResponse.reject(err);
                    this._currentResponse = null;
                }
            });

            this.socket.on('timeout', () => {
                const err = new Error('Connection timeout');
                this.emit('timeout');
                if (this._currentResponse) {
                    this._currentResponse.reject(err);
                    this._currentResponse = null;
                }
            });

            this.socket.on('close', () => {
                this.connected = false;
                this.authenticated = false;
                this.emit('close');
            });
        });
    }

    /**
     * Disconnect from the server
     */
    async disconnect() {
        if (!this.connected) return;

        try {
            await this._sendCommand('QUIT');
        } catch (e) {
            // Ignore errors on quit
        }

        this.socket.destroy();
        this.connected = false;
        this.authenticated = false;
    }

    /**
     * Authenticate with the server
     */
    async _authenticate() {
        // Send username
        const userResponse = await this._sendCommand(`AUTHINFO USER ${this.username}`);

        if (userResponse.code === RESPONSE_CODES.AUTH_CONTINUE) {
            // Send password
            const passResponse = await this._sendCommand(`AUTHINFO PASS ${this.password}`);

            if (passResponse.code !== RESPONSE_CODES.AUTH_ACCEPTED) {
                throw new Error(`Authentication failed: ${passResponse.message}`);
            }
        } else if (userResponse.code !== RESPONSE_CODES.AUTH_ACCEPTED) {
            throw new Error(`Authentication failed: ${userResponse.message}`);
        }

        this.authenticated = true;
    }

    /**
     * Select a newsgroup
     */
    async group(groupName) {
        const response = await this._sendCommand(`GROUP ${groupName}`);

        if (response.code === RESPONSE_CODES.NO_SUCH_GROUP) {
            throw new Error(`Group not found: ${groupName}`);
        }

        if (response.code !== RESPONSE_CODES.GROUP_SELECTED) {
            throw new Error(`Failed to select group: ${response.message}`);
        }

        // Parse group info: 211 count first last group
        const parts = response.message.split(' ');
        this.currentGroup = groupName;

        return {
            count: parseInt(parts[0], 10),
            first: parseInt(parts[1], 10),
            last: parseInt(parts[2], 10),
            name: parts[3]
        };
    }

    /**
     * Get article body by message-id
     */
    async body(messageId) {
        const id = messageId.startsWith('<') ? messageId : `<${messageId}>`;
        const response = await this._sendCommand(`BODY ${id}`, true);

        if (response.code === RESPONSE_CODES.NO_SUCH_ARTICLE) {
            throw new Error(`Article not found: ${messageId}`);
        }

        if (response.code !== RESPONSE_CODES.ARTICLE_BODY) {
            throw new Error(`Failed to get article: ${response.message}`);
        }

        return response.data;
    }

    /**
     * Check if article exists (STAT command)
     */
    async stat(messageId) {
        const id = messageId.startsWith('<') ? messageId : `<${messageId}>`;
        const response = await this._sendCommand(`STAT ${id}`);

        return response.code === RESPONSE_CODES.ARTICLE_STAT;
    }

    /**
     * Send a command and wait for response
     */
    async _sendCommand(command, multiLine = false) {
        if (!this.connected) {
            throw new Error('Not connected');
        }

        return new Promise((resolve, reject) => {
            this._currentResponse = { resolve, reject, multiLine, data: null };

            // Send command
            this.socket.write(command + '\r\n');
        });
    }

    /**
     * Wait for initial server response
     */
    async _waitForResponse() {
        return new Promise((resolve, reject) => {
            this._currentResponse = { resolve, reject, multiLine: false, data: null };
        });
    }

    /**
     * Handle incoming data
     */
    _onData(data) {
        this._buffer = Buffer.concat([this._buffer, data]);

        while (this._processBuffer()) {
            // Continue processing while there's complete data
        }
    }

    /**
     * Process the data buffer
     * @returns {boolean} True if data was processed
     */
    _processBuffer() {
        if (!this._currentResponse) return false;

        if (this._currentResponse.multiLine && this._currentResponse.headerParsed) {
            // Looking for end of multi-line response (line with just ".")
            const endMarker = Buffer.from('\r\n.\r\n');
            const endIndex = this._buffer.indexOf(endMarker);

            if (endIndex === -1) return false;

            // Extract data (everything before the end marker)
            const dataEnd = endIndex;
            this._currentResponse.data = this._buffer.slice(0, dataEnd);

            // Remove processed data from buffer
            this._buffer = this._buffer.slice(endIndex + endMarker.length);

            // Resolve with complete response
            const response = this._currentResponse;
            this._currentResponse = null;
            response.resolve({
                code: response.code,
                message: response.message,
                data: response.data
            });

            return true;
        }

        // Looking for first line (response code)
        const lineEnd = this._buffer.indexOf('\r\n');
        if (lineEnd === -1) return false;

        const line = this._buffer.slice(0, lineEnd).toString('utf8');
        this._buffer = this._buffer.slice(lineEnd + 2);

        // Parse response code
        const code = parseInt(line.substring(0, 3), 10);
        const message = line.substring(4);

        if (this._currentResponse.multiLine) {
            // Store header info and continue reading
            this._currentResponse.code = code;
            this._currentResponse.message = message;
            this._currentResponse.headerParsed = true;
            return true;
        }

        // Single-line response - resolve immediately
        const response = this._currentResponse;
        this._currentResponse = null;
        response.resolve({ code, message });

        return true;
    }

    /**
     * Check if connection is active
     */
    isConnected() {
        return this.connected && this.socket && !this.socket.destroyed;
    }
}

/**
 * NNTP Connection Pool
 * Manages multiple connections to usenet providers
 */
class NNTPConnectionPool extends EventEmitter {
    constructor(provider, maxConnections = 10) {
        super();
        this.provider = provider;
        this.maxConnections = maxConnections;
        this.connections = [];
        this.available = [];
        this.waiting = [];
    }

    /**
     * Initialize the connection pool
     */
    async initialize(count = this.maxConnections) {
        const connectionPromises = [];

        for (let i = 0; i < count; i++) {
            connectionPromises.push(this._createConnection());
        }

        const results = await Promise.allSettled(connectionPromises);

        for (const result of results) {
            if (result.status === 'fulfilled') {
                this.connections.push(result.value);
                this.available.push(result.value);
            }
        }

        if (this.connections.length === 0) {
            throw new Error('Failed to create any connections');
        }

        return this.connections.length;
    }

    /**
     * Create a new connection
     */
    async _createConnection() {
        const conn = new NNTPConnection({
            host: this.provider.host,
            port: this.provider.port,
            ssl: this.provider.ssl,
            username: this.provider.username,
            password: this.provider.password
        });

        await conn.connect();
        return conn;
    }

    /**
     * Acquire a connection from the pool
     */
    async acquire() {
        if (this.available.length > 0) {
            const conn = this.available.pop();
            if (conn.isConnected()) {
                return conn;
            }
            // Connection died, remove it and try to create a new one
            this._removeConnection(conn);
            return this.acquire();
        }

        // No connections available, wait for one
        return new Promise((resolve, reject) => {
            const timeout = setTimeout(() => {
                const index = this.waiting.findIndex(w => w.resolve === resolve);
                if (index !== -1) {
                    this.waiting.splice(index, 1);
                }
                reject(new Error('Connection acquire timeout'));
            }, 30000);

            this.waiting.push({ resolve, reject, timeout });
        });
    }

    /**
     * Release a connection back to the pool
     */
    release(conn) {
        if (!conn.isConnected()) {
            this._removeConnection(conn);
            return;
        }

        // Check if anyone is waiting
        if (this.waiting.length > 0) {
            const waiter = this.waiting.shift();
            clearTimeout(waiter.timeout);
            waiter.resolve(conn);
            return;
        }

        // Return to available pool
        this.available.push(conn);
    }

    /**
     * Remove a connection from the pool
     */
    _removeConnection(conn) {
        const index = this.connections.indexOf(conn);
        if (index !== -1) {
            this.connections.splice(index, 1);
        }
        conn.disconnect().catch(() => {});
    }

    /**
     * Close all connections
     */
    async close() {
        // Reject all waiting requests
        for (const waiter of this.waiting) {
            clearTimeout(waiter.timeout);
            waiter.reject(new Error('Pool closed'));
        }
        this.waiting = [];

        // Close all connections
        const closePromises = this.connections.map(conn => conn.disconnect());
        await Promise.allSettled(closePromises);

        this.connections = [];
        this.available = [];
    }

    /**
     * Get pool statistics
     */
    getStats() {
        return {
            total: this.connections.length,
            available: this.available.length,
            inUse: this.connections.length - this.available.length,
            waiting: this.waiting.length
        };
    }
}

module.exports = {
    NNTPConnection,
    NNTPConnectionPool,
    RESPONSE_CODES
};
