import {
  ChannelHandoffRegistry,
  type ChannelHandoffHandler,
} from './channel-handoff.registry';

const handler = (userIdPrefix: string): ChannelHandoffHandler => ({
  userIdPrefix,
  requestAdmin: jest.fn().mockResolvedValue('REQUESTED'),
});

describe('ChannelHandoffRegistry.find', () => {
  it('prefers a prefixed channel over the empty-prefix (LINE) handler, in any registration order', () => {
    const line = handler('');
    const app = handler('app:');
    const fb = handler('fb:');

    for (const order of [
      [line, app, fb],
      [app, fb, line],
    ]) {
      const registry = new ChannelHandoffRegistry();
      order.forEach((h) => registry.register(h));
      expect(registry.find('app:123')).toBe(app);
      expect(registry.find('fb:123')).toBe(fb);
      expect(registry.find('Uf3c')).toBe(line);
    }
  });

  it('returns undefined when nothing matches', () => {
    const registry = new ChannelHandoffRegistry();
    registry.register(handler('app:'));
    expect(registry.find('Uf3c')).toBeUndefined();
  });
});
