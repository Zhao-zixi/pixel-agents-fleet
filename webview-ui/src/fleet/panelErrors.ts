/** Polling recovery must not erase a failed user action that still needs attention. */
export interface FleetPanelErrors {
  connection: string;
  action: string;
}

export type FleetPanelErrorEvent =
  | { type: 'refreshSucceeded' }
  | { type: 'refreshFailed'; message: string }
  | { type: 'actionStarted' }
  | { type: 'actionFailed'; message: string };

export const initialFleetPanelErrors: FleetPanelErrors = { connection: '', action: '' };

export function fleetPanelErrorReducer(
  state: FleetPanelErrors,
  event: FleetPanelErrorEvent,
): FleetPanelErrors {
  switch (event.type) {
    case 'refreshSucceeded':
      return { ...state, connection: '' };
    case 'refreshFailed':
      return { ...state, connection: event.message };
    case 'actionStarted':
      return { ...state, action: '' };
    case 'actionFailed':
      return { ...state, action: event.message };
  }
}
