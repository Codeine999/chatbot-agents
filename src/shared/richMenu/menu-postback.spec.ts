import {
  encodeMenuIntentPostback,
  encodeMenuReplyPostback,
  isMenuPostback,
  parseMenuPostback,
} from './menu-postback';

describe('menu postback grammar', () => {
  it('round-trips a tenant reply key', () => {
    const data = encodeMenuReplyPostback('promo_today');

    expect(data).toBe('menu=promo_today');
    expect(parseMenuPostback(data)).toEqual({
      kind: 'reply',
      key: 'promo_today',
    });
  });

  it('round-trips a built-in intent', () => {
    const data = encodeMenuIntentPostback('REGISTER');

    expect(data).toBe('intent=REGISTER');
    expect(parseMenuPostback(data)).toEqual({
      kind: 'intent',
      intent: 'REGISTER',
    });
  });

  it('rejects an intent the product does not implement', () => {
    // A typo here would otherwise ship as a dead button on a published menu.
    expect(parseMenuPostback('intent=REGISTR')).toBeNull();
    expect(isMenuPostback('intent=REGISTR')).toBe(true);
  });

  it('rejects a key that is not a lowercase slug', () => {
    expect(parseMenuPostback('menu=Promo Today')).toBeNull();
    expect(parseMenuPostback('menu=')).toBeNull();
    expect(parseMenuPostback(`menu=${'a'.repeat(65)}`)).toBeNull();
  });

  it('leaves a tenant\'s own convention alone', () => {
    // Menus published before this format still work; they simply route normally.
    expect(parseMenuPostback('action=legacy')).toBeNull();
    expect(isMenuPostback('action=legacy')).toBe(false);
  });

  it('ignores surrounding whitespace from the wire', () => {
    expect(parseMenuPostback('  menu=register  ')).toEqual({
      kind: 'reply',
      key: 'register',
    });
  });
});
