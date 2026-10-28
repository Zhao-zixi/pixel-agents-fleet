import { describe, expect, it } from 'vitest';

import { OfficeState } from '../src/office/engine/officeState.js';

describe('Fleet character terminal ownership and revival', () => {
  it('routes siblings and their subagents to the shared process without requiring its character', () => {
    const office = new OfficeState();
    office.addAgent(2);
    office.characters.get(2)!.terminalOwnerId = 1;
    office.subagentMeta.set(-1, { parentAgentId: 2, parentToolId: 'task' });
    expect(office.terminalOwnerOf(2)).toBe(1);
    expect(office.terminalOwnerOf(-1)).toBe(1);
    expect(office.terminalOwnerOf(99)).toBe(99);
  });
  it('revives the same ID even if its hide animation has not finished', () => {
    const office = new OfficeState();
    office.addAgent(1, 2, 30);
    office.removeAgent(1);
    expect(office.characters.get(1)?.matrixEffect).toBe('despawn');
    office.addAgent(1, 2, 30);
    expect(office.characters.size).toBe(1);
    expect(office.characters.get(1)?.matrixEffect).not.toBe('despawn');
    expect(office.characters.get(1)?.palette).toBe(2);
  });
});
