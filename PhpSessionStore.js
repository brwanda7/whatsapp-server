const fs   = require('fs');
const path = require('path');

class PhpSessionStore {
  constructor(apiUrl, apiKey) {
    this.apiUrl  = apiUrl;
    this.apiKey  = apiKey;
    this.headers = {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    };
  }

  async sessionExists({ session }) {
    try {
      const res  = await fetch(`${this.apiUrl}/v1/whatsapp/session-load`, {
        method:  'POST',
        headers: this.headers,
        body:    JSON.stringify({ session_id: session }),
      });
      const json = await res.json();
      console.log(`[Store] sessionExists(${session}):`, json.success);
      return json.success === true;
    } catch (err) {
      console.error('[Store] sessionExists error:', err.message);
      return false;
    }
  }

  async save({ session, data }) {
    try {
      // data is a zip file Buffer — convert to base64
      const base64 = Buffer.isBuffer(data)
        ? data.toString('base64')
        : Buffer.from(data).toString('base64');

      const res = await fetch(`${this.apiUrl}/v1/whatsapp/session-save`, {
        method:  'POST',
        headers: this.headers,
        body:    JSON.stringify({
          session_id:   session,
          session_data: base64,
        }),
      });
      const json = await res.json();
      console.log(`[Store] save(${session}):`, json.success);
    } catch (err) {
      console.error('[Store] save error:', err.message);
    }
  }

  async extract({ session, path: destPath }) {
    try {
      const res  = await fetch(`${this.apiUrl}/v1/whatsapp/session-load`, {
        method:  'POST',
        headers: this.headers,
        body:    JSON.stringify({ session_id: session }),
      });
      const json = await res.json();
      if (!json.success || !json.session_data) {
        console.log(`[Store] extract(${session}): no session found`);
        return;
      }

      // session_data is base64 — write as zip file to destPath
      const buffer = Buffer.from(json.session_data, 'base64');
      fs.writeFileSync(destPath, buffer);
      console.log(`[Store] extract(${session}): written to ${destPath}`);
    } catch (err) {
      console.error('[Store] extract error:', err.message);
    }
  }

  async delete({ session }) {
    try {
      const res  = await fetch(`${this.apiUrl}/v1/whatsapp/session-delete`, {
        method:  'POST',
        headers: this.headers,
        body:    JSON.stringify({ session_id: session }),
      });
      const json = await res.json();
      console.log(`[Store] delete(${session}):`, json.success);
    } catch (err) {
      console.error('[Store] delete error:', err.message);
    }
  }
}

module.exports = PhpSessionStore;