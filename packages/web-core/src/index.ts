/**
 * @signal/web-core — the one framework-agnostic renderer of the feedback sheet
 * (F1). Pure render + state machine; it never touches the network, only the
 * SheetHost. See docs/sheet-bridge-v1.md for the cross-language bridge schema.
 */

export { SUPPORTED_CONFIG_VERSION } from './config.js';
export type { DismissReason, SheetHandle, SheetHost } from './host.js';
export type { MachineConfig, ResolvedAction, SheetState } from './machine.js';
// Re-export the pure machine + guards for advanced embedders / testing.
export { isPositive, negativeHasCapture, SheetMachine } from './machine.js';
export { mount } from './mount.js';
export type { Action, ActionType, Answer, WorkflowConfig } from './types.js';
