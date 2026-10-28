import { describe, expect, it } from 'vitest';

import { fleetPanelErrorReducer, initialFleetPanelErrors } from '../src/fleet/panelErrors.js';

describe('Fleet panel polling and action errors', () => {
  it('clears a transient polling error after a successful full refresh', () => {
    const failed = fleetPanelErrorReducer(initialFleetPanelErrors, {
      type: 'refreshFailed',
      message: 'Network unavailable',
    });
    expect(failed.connection).toBe('Network unavailable');
    expect(fleetPanelErrorReducer(failed, { type: 'refreshSucceeded' })).toEqual(
      initialFleetPanelErrors,
    );
  });

  it('keeps the latest error during consecutive failures, then recovers', () => {
    let errors = fleetPanelErrorReducer(initialFleetPanelErrors, {
      type: 'refreshFailed',
      message: 'First failure',
    });
    errors = fleetPanelErrorReducer(errors, {
      type: 'refreshFailed',
      message: 'Detail request failed',
    });
    expect(errors.connection).toBe('Detail request failed');
    expect(fleetPanelErrorReducer(errors, { type: 'refreshSucceeded' }).connection).toBe('');
  });

  it('does not hide a failed action when polling recovers', () => {
    let errors = fleetPanelErrorReducer(initialFleetPanelErrors, {
      type: 'actionFailed',
      message: 'Agent launch rejected',
    });
    errors = fleetPanelErrorReducer(errors, { type: 'refreshFailed', message: 'Offline' });
    errors = fleetPanelErrorReducer(errors, { type: 'refreshSucceeded' });
    expect(errors).toEqual({ connection: '', action: 'Agent launch rejected' });
    errors = fleetPanelErrorReducer(errors, { type: 'refreshSucceeded' });
    expect(errors.action).toBe('Agent launch rejected');
  });

  it('clears only the previous action error when retrying an action', () => {
    const errors = { connection: 'Still offline', action: 'Agent launch rejected' };
    expect(fleetPanelErrorReducer(errors, { type: 'actionStarted' })).toEqual({
      connection: 'Still offline',
      action: '',
    });
  });
});
