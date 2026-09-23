import { resolveRetrievalQuery } from '../retrieval-query-planner.service';
import { userMessage } from './knowledge.fixtures';
import { CLARIFY_MESSAGE } from '../../constants/knowledge-routing.constants';

describe('resolveRetrievalQuery', () => {
  it('ข้อความปกติที่ไม่ได้อ้างถึงของเดิม ส่งผ่านตรง ๆ', () => {
    expect(resolveRetrievalQuery('ราคารุ่น A เท่าไร', [])).toEqual({
      query: 'ราคารุ่น A เท่าไร',
      missingReference: false,
    });
  });

  it('คำอ้างอิงแบบอังกฤษก็จับได้ (this one/that one/it)', () => {
    expect(
      resolveRetrievalQuery('how much is this one', []).missingReference,
    ).toBe(true);
  });

  it('อ้างถึงของเดิมแต่ระบุรุ่นมาเองในประโยค ใช้ข้อความเดิมได้เลย', () => {
    expect(resolveRetrievalQuery('อันนี้ รุ่น A ราคาเท่าไร', [])).toEqual({
      query: 'อันนี้ รุ่น A ราคาเท่าไร',
      missingReference: false,
    });
  });

  it('ระบุมาสองรุ่นในประโยคเดียว = ไม่รู้ว่าหมายถึงตัวไหน ต้องถามกลับ', () => {
    expect(
      resolveRetrievalQuery('อันนี้ รุ่น A กับ รุ่น B อันไหนถูกกว่า', [])
        .missingReference,
    ).toBe(true);
  });

  it('เติมรุ่นจากประวัติให้เมื่อบทสนทนาก่อนหน้าพูดถึงรุ่นเดียว', () => {
    const result = resolveRetrievalQuery('อันนี้ราคาเท่าไร', [
      userMessage('สนใจ รุ่น A ครับ'),
    ]);

    expect(result).toEqual({
      query: 'รุ่น a\nอันนี้ราคาเท่าไร',
      missingReference: false,
    });
  });

  it('ประวัติไม่เคยพูดถึงรุ่นไหนเลย ต้องถามกลับ ไม่ใช่เดาจากคะแนน vector', () => {
    expect(
      resolveRetrievalQuery('อันนี้ราคาเท่าไร', [userMessage('สวัสดีครับ')])
        .missingReference,
    ).toBe(true);
  });

  it('ประวัติมีหลายรุ่นปนกัน ต้องถามกลับ', () => {
    expect(
      resolveRetrievalQuery('อันนี้ราคาเท่าไร', [
        userMessage('รุ่น A ดีไหม'),
        userMessage('แล้ว รุ่น B ล่ะ'),
      ]).missingReference,
    ).toBe(true);
  });

  it('พูดถึงรุ่นเดิมซ้ำหลายข้อความ ยังนับเป็นรุ่นเดียว', () => {
    expect(
      resolveRetrievalQuery('อันนี้ราคาเท่าไร', [
        userMessage('รุ่น A ดีไหม'),
        userMessage('รุ่น A มีสีอะไรบ้าง'),
      ]),
    ).toEqual({ query: 'รุ่น a\nอันนี้ราคาเท่าไร', missingReference: false });
  });

  it('มองย้อนหลังแค่ 6 ข้อความ รุ่นที่พูดไว้ก่อนหน้านั้นถือว่าหลุดบริบทแล้ว', () => {
    const history = [
      userMessage('รุ่น A ดีไหม'),
      ...Array.from({ length: 6 }, () => userMessage('ครับ')),
    ];

    expect(
      resolveRetrievalQuery('อันนี้ราคาเท่าไร', history).missingReference,
    ).toBe(true);
  });

  it('อ่านข้อความประวัติแค่ 1000 ตัวแรก กันข้อความยาวผิดปกติมาถ่วง', () => {
    const buried = `${'ก'.repeat(1000)} รุ่น A`;

    expect(
      resolveRetrievalQuery('อันนี้ราคาเท่าไร', [userMessage(buried)])
        .missingReference,
    ).toBe(true);
  });

  it.each([
    ['สนใจโรงแรมริมทะเล', 'โรงแรมนี้ราคาเท่าไร'],
    ['โปรโมชั่นส่งฟรีมีไหม', 'อันนี้ใช้ถึงวันไหน'],
    ['สนใจสินค้าเครื่องกรองน้ำ', 'สินค้านี้รับประกันกี่ปี'],
  ])('ใช้หัวข้อธุรกิจล่าสุดจากประวัติ: %s → %s', (previous, input) => {
    expect(resolveRetrievalQuery(input, [userMessage(previous)])).toEqual({
      query: `${previous}\n${input}`,
      missingReference: false,
    });
  });

  it('หลังถามให้ระบุหัวข้อ นำคำตอบสั้นมารวมกับคำถามเดิม', () => {
    const history = [
      userMessage('อันนี้ราคาเท่าไร'),
      {
        role: 'assistant' as const,
        text: CLARIFY_MESSAGE,
        source: 'RULE' as const,
        createdAt: Date.now(),
      },
    ];
    expect(resolveRetrievalQuery('โรงแรมริมทะเล', history)).toEqual({
      query: 'โรงแรมริมทะเล\nอันนี้ราคาเท่าไร',
      missingReference: false,
    });
  });

  it('ไม่เดาหัวข้อเมื่อข้อความก่อนหน้าระบุสองทางเลือก', () => {
    expect(
      resolveRetrievalQuery('อันนี้ราคาเท่าไร', [
        userMessage('สนใจโรงแรมริมทะเลกับโรงแรมภูเขา'),
      ]).missingReference,
    ).toBe(true);
  });

  it('ไม่ใช้ข้อความก่อนหน้าที่มีข้อมูลส่วนตัวเป็น search query', () => {
    expect(
      resolveRetrievalQuery('อันนี้ราคาเท่าไร', [
        userMessage('อีเมล somchai@example.com'),
      ]).missingReference,
    ).toBe(true);
  });
});
