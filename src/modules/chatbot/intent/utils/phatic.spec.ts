import { detectPhatic, type PhaticKind } from './phatic';

describe('detectPhatic', () => {
  describe('accepts a message that is only an acknowledgement', () => {
    it.each<[string, PhaticKind]>([
      // particles, including real typos and stretched letters
      ['ครับ', 'PARTICLE_ONLY'],
      ['ค่ะ', 'PARTICLE_ONLY'],
      ['คะ', 'PARTICLE_ONLY'],
      ['ครัค่ะ', 'PARTICLE_ONLY'],
      ['ค่ร่ะ', 'PARTICLE_ONLY'],
      ['คับบบ', 'PARTICLE_ONLY'],
      ['ค่าาาา', 'PARTICLE_ONLY'],
      ['ครับผม', 'PARTICLE_ONLY'],
      ['ครับครับ', 'PARTICLE_ONLY'],
      ['ค่ะ.', 'PARTICLE_ONLY'],
      ['ค่ะ 😊', 'PARTICLE_ONLY'],
      ['KRUB', 'PARTICLE_ONLY'],
      ['kub', 'PARTICLE_ONLY'],
      ['kha', 'PARTICLE_ONLY'],
      // a cut-off particle followed by a whole one
      ['ครัคะ', 'PARTICLE_ONLY'],
      // acknowledgements
      ['โอเคค่ะ', 'ACK'],
      ['ok ครับ', 'ACK'],
      ['OK', 'ACK'],
      ['โอเคนะคะ', 'ACK'],
      ['รับทราบค่ะ', 'ACK'],
      ['อ๋อ ค่ะ', 'ACK'],
      ['อืม', 'ACK'],
      ['👍', 'ACK'],
      ['👌', 'ACK'],
      ['😊', 'ACK'],
      // thanks
      ['ขอบคุณค่ะ', 'THANKS'],
      ['ขอบคุณมากครับ', 'THANKS'],
      ['ขอบคุณนะคะ', 'THANKS'],
      ['ขอบคุณค่าาา', 'THANKS'],
      ['thanks', 'THANKS'],
      ['Thx ครับ', 'THANKS'],
      ['🙏', 'THANKS'],
      ['ขอบคุณค่ะ🙏', 'THANKS'],
      // farewell
      ['บายค่ะ', 'CLOSING'],
      ['บ๊ายบายค่ะ', 'CLOSING'],
      ['แค่นี้ก่อนนะคะ', 'CLOSING'],
      // nudges
      ['??', 'PING'],
      ['?', 'PING'],
      ['ยังอยู่ไหมคะ', 'PING'],
      ['มีใครอยู่ไหมครับ', 'PING'],
      ['ฮัลโหล', 'PING'],
      ['hellooo', 'PING'],
      // laughter
      ['555', 'LAUGH'],
      ['55555', 'LAUGH'],
    ])('%s -> %s', (text, kind) => {
      expect(detectPhatic(text)).toEqual({ kind });
    });
  });

  describe('refuses anything that carries content or a question', () => {
    it.each([
      // questions and offers answered in one word
      'ได้ปะ',
      'ได้ไหม',
      'ได้ไหมคะ',
      'ได้กี่ที่',
      'โอเคไหม',
      'อยู่ไหน',
      'ปะ',
      'ป่ะ',
      'ป่าวค่ะ',
      'หรอคะ',
      'เหรอครับ',
      'อะไรครับ',
      'ทำไมคะ',
      'ยังไงคะ',
      'เท่าไหร่ครับ',
      'ครับ?',
      // answers to a question belong to the classifier
      'ใช่',
      'ใช่ค่ะ',
      'ได้',
      'ได้เลย',
      'ได้ค่ะ',
      'ไม่',
      'ไม่ใช่',
      'ไม่เอา',
      'เค',
      // content after the acknowledgement
      'ครับ แล้วราคาล่ะ',
      'ค่ะ พรุ่งนี้',
      'ค่ะ 5 ที่',
      'ok 2 คน',
      'ok2',
      'ขอบคุณค่ะ แล้วจองยังไง',
      'ขอบคุณค่ะ ส่งที่อยู่ให้แล้ว',
      'ไม่เป็นไรค่ะ',
      // lookalikes
      'บายพาส',
      'คุยกับคนจริง',
      'สวัสดีครับ',
      'รอบรถ',
      // emoji and nothing
      '😡',
      'โอเค 😡',
      '',
      '   ',
      '...',
    ])('%j -> null', (text) => {
      expect(detectPhatic(text)).toBeNull();
    });
  });

  it('ignores zero-width joiners and variation selectors', () => {
    expect(detectPhatic('ค‍รับ')).toEqual({ kind: 'PARTICLE_ONLY' });
    expect(detectPhatic('☺️')).toEqual({ kind: 'ACK' });
  });

  it('does not match a cut-off particle that is not followed by a whole one', () => {
    expect(detectPhatic('ครั')).toBeNull();
    expect(detectPhatic('ครัก')).toBeNull();
  });

  it('never throws on arbitrary input', () => {
    for (const text of ['\u0000', '👨‍👩‍👧', 'ก'.repeat(5000), '?'.repeat(100)]) {
      expect(() => detectPhatic(text)).not.toThrow();
    }
  });
});
