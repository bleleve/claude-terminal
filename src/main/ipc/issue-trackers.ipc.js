'use strict';

/**
 * Issue tracker IPC: providers and connections.
 *
 * Keys go one way. The renderer hands a key over once, to `connect`; nothing
 * here ever sends one back, only a masked form. Errors keep their tracker
 * `code`, because Electron drops custom properties from a thrown error and the
 * UI words AUTH, RATE_LIMITED and NETWORK differently.
 */

const { ipcMain } = require('electron');
const issueTrackers = require('../services/IssueTrackerService');

function fail(err) {
  return { ok: false, error: err.message, code: err.code || 'PROVIDER', retryAfterMs: err.retryAfterMs };
}

function registerIssueTrackerHandlers() {
  ipcMain.handle('issue-trackers:providers', async () => {
    try {
      return { ok: true, providers: issueTrackers.listProviders() };
    } catch (err) {
      return fail(err);
    }
  });

  ipcMain.handle('issue-trackers:connections', async () => {
    try {
      return { ok: true, connections: await issueTrackers.listConnections() };
    } catch (err) {
      return fail(err);
    }
  });

  ipcMain.handle('issue-trackers:connect', async (_event, provider, secret) => {
    try {
      return { ok: true, connection: await issueTrackers.connect(provider, secret) };
    } catch (err) {
      return fail(err);
    }
  });

  ipcMain.handle('issue-trackers:disconnect', async (_event, connectionId) => {
    try {
      await issueTrackers.disconnect(connectionId);
      return { ok: true };
    } catch (err) {
      return fail(err);
    }
  });

  ipcMain.handle('issue-trackers:test', async (_event, connectionId) => {
    try {
      return { ok: true, connection: await issueTrackers.test(connectionId) };
    } catch (err) {
      return fail(err);
    }
  });
}

module.exports = { registerIssueTrackerHandlers };
