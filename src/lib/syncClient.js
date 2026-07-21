import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import Soup from 'gi://Soup';

Gio._promisify(Soup.Session.prototype, 'send_and_read_async', 'send_and_read_finish');

// Thin HTTP client for the provider contract (docs/provider-contract.md).
// Wire knowledge beyond paths/verbs lives in syncProtocol.js.

export class SyncHttpError extends Error {
    constructor(status, message) {
        super(message ?? `HTTP ${status}`);
        this.status = status;
    }
}

export class SyncClient {
    /**
     * @param {string} baseUrl provider base URL (with or without trailing slash)
     * @param {string} token app bearer token
     */
    constructor(baseUrl, token) {
        this._base = baseUrl.replace(/\/+$/, '');
        this._token = token;
        this._session = new Soup.Session({timeout: 30});
    }

    destroy() {
        this._session?.abort();
        this._session = null;
    }

    /**
     * @param {?string} etag last seen ETag for If-None-Match
     * @returns {Promise<?{json: object, etag: ?string}>} null on 304 Not Modified
     */
    async getBoard(etag) {
        const message = this._message('GET', '/v1/board');
        if (etag)
            message.get_request_headers().append('If-None-Match', etag);
        const {status, body, headers} = await this._send(message);
        if (status === 304)
            return null;
        this._expect2xx(status, body);
        return {json: JSON.parse(body), etag: headers.get_one('ETag')};
    }

    /** @returns {Promise<object>} the created (or pre-existing) task */
    async createTask(id, title) {
        const message = this._message('POST', '/v1/tasks', {id, title, created_by: 'user'});
        const {status, body} = await this._send(message);
        this._expect2xx(status, body);
        return JSON.parse(body);
    }

    /** @returns {Promise<{notFound: boolean}>} 404 is a defined outcome, not an error */
    async patchTask(id, done) {
        const message = this._message('PATCH', `/v1/tasks/${encodeURIComponent(id)}`, {done});
        const {status, body} = await this._send(message);
        if (status === 404)
            return {notFound: true};
        this._expect2xx(status, body);
        return {notFound: false};
    }

    async deleteTask(id) {
        const message = this._message('DELETE', `/v1/tasks/${encodeURIComponent(id)}`);
        const {status, body} = await this._send(message);
        if (status !== 404)
            this._expect2xx(status, body);
    }

    _message(method, path, jsonBody = null) {
        const message = Soup.Message.new(method, `${this._base}${path}`);
        if (!message)
            throw new SyncHttpError(0, `invalid provider URL: ${this._base}`);
        message.get_request_headers().append('Authorization', `Bearer ${this._token}`);
        if (jsonBody !== null) {
            message.set_request_body_from_bytes('application/json',
                new GLib.Bytes(new TextEncoder().encode(JSON.stringify(jsonBody))));
        }
        return message;
    }

    async _send(message) {
        const bytes = await this._session.send_and_read_async(
            message, GLib.PRIORITY_DEFAULT, null);
        return {
            status: message.get_status(),
            body: new TextDecoder().decode(bytes.get_data() ?? new Uint8Array()),
            headers: message.get_response_headers(),
        };
    }

    _expect2xx(status, body) {
        if (status < 200 || status >= 300) {
            let detail = '';
            try {
                detail = JSON.parse(body)?.message ?? '';
            } catch {
                // non-JSON error body
            }
            throw new SyncHttpError(status, detail || `HTTP ${status}`);
        }
    }
}
