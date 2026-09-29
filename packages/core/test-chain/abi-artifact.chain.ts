// Revisão do Claude (M2a): o ABI escrito à mão em src/abi.ts contra o artifact que o solc gerou.
import { describe, expect, it } from 'vitest';
import { toEventSelector, toFunctionSelector, type AbiParameter } from 'viem';
import { deliverProofAbi } from '../src/abi.js';
import { artifact } from './hardhat-node.js';

type Item = {
  type: string;
  name?: string;
  inputs?: AbiParameter[];
  outputs?: AbiParameter[];
  stateMutability?: string;
  anonymous?: boolean;
};
const norm = (ps: readonly AbiParameter[] = []): unknown =>
  ps.map(p => ({
    name: p.name ?? '',
    type: p.type,
    indexed: (p as { indexed?: boolean }).indexed ?? false,
    components: 'components' in p ? norm(p.components) : undefined,
  }));
const key = (x: Item) => `${x.type}:${x.name ?? ''}`;
const shape = (x: Item) => ({
  type: x.type,
  name: x.name,
  inputs: norm(x.inputs),
  outputs: x.type === 'function' ? norm(x.outputs) : undefined,
  stateMutability: x.type === 'function' ? x.stateMutability : undefined,
  anonymous: x.type === 'event' ? (x.anonymous ?? false) : undefined,
});

describe('ABI de src/abi.ts x artifact do DeliverProof.sol', () => {
  const compiled = artifact().abi as Item[];
  const declared = deliverProofAbi as unknown as Item[];
  it('cada item declarado existe no artifact com tipos, nomes, indexed, mutabilidade e seletor iguais', () => {
    for (const d of declared) {
      const c = compiled.find(x => key(x) === key(d));
      expect(c, key(d)).toBeDefined();
      expect(shape(d), key(d)).toEqual(shape(c!));
      if (d.type === 'function' || d.type === 'error')
        expect(toFunctionSelector(d as never)).toBe(toFunctionSelector(c as never));
      if (d.type === 'event') expect(toEventSelector(d as never)).toBe(toEventSelector(c as never));
    }
  });
  it('o artifact tem só estes itens a mais (nenhuma função de escrita ou evento faltando)', () => {
    const extra = compiled
      .filter(c => !declared.some(d => key(d) === key(c)))
      .map(key)
      .sort();
    expect(extra).toEqual([
      'constructor:',
      'fallback:',
      'function:DOMAIN',
      'function:MAX_AMOUNT_TINYBAR',
      'function:MAX_FILE_BYTES',
      'function:nextId',
      'function:totalCredits',
      'function:totalLocked',
      'receive:',
    ]);
    const missingWrites = compiled.filter(
      c =>
        (c.type === 'event' ||
          (c.type === 'function' && c.stateMutability !== 'view' && c.stateMutability !== 'pure')) &&
        !declared.some(d => key(d) === key(c)),
    );
    expect(missingWrites).toEqual([]);
  });
});
