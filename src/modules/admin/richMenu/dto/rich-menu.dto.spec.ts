import { z } from 'zod';
import {
  CreateRichMenuTemplateDto,
  ListRichMenuTemplateQueryDto,
  PublishRichMenuTemplateDto,
  RichMenuStatsQueryDto,
  UpdateRichMenuTemplateDto,
} from './rich-menu.dto';

const AREA = {
  bounds: { x: 0, y: 0, width: 834, height: 843 },
  action: {
    type: 'postback',
    label: 'สินค้า',
    data: 'action=open_products',
    displayText: 'ดูสินค้า',
  },
};

const BASE_BODY = {
  name: 'Main Menu',
  chatBarText: 'เปิดเมนู',
  size: { width: 2500, height: 1686 },
  areas: [AREA],
};

describe('Rich menu DTO schemas', () => {
  it('stays representable in the OpenAPI document the app publishes', () => {
    // Bootstrap runs cleanupOpenApiDoc() over every DTO; a schema it cannot
    // render kills the app before it can listen.
    for (const dto of [
      CreateRichMenuTemplateDto,
      UpdateRichMenuTemplateDto,
      ListRichMenuTemplateQueryDto,
      PublishRichMenuTemplateDto,
      RichMenuStatsQueryDto,
    ]) {
      expect(() => z.toJSONSchema(dto.schema, { io: 'input' })).not.toThrow();
    }
  });

  it('accepts the standard 2500x1686 menu and defaults selected to true', () => {
    expect(CreateRichMenuTemplateDto.schema.parse(BASE_BODY)).toMatchObject({
      selected: true,
      areas: [AREA],
    });
  });

  it('rejects a size LINE does not support', () => {
    expect(() =>
      CreateRichMenuTemplateDto.schema.parse({
        ...BASE_BODY,
        size: { width: 2000, height: 1000 },
      }),
    ).toThrow(/size must be one of/);
  });

  it('rejects an area that hangs off the canvas', () => {
    expect(() =>
      CreateRichMenuTemplateDto.schema.parse({
        ...BASE_BODY,
        areas: [
          {
            ...AREA,
            bounds: { x: 2000, y: 0, width: 834, height: 843 },
          },
        ],
      }),
    ).toThrow(/outside the 2500x1686 menu/);
  });

  it('rejects an action missing the field its type requires', () => {
    expect(() =>
      CreateRichMenuTemplateDto.schema.parse({
        ...BASE_BODY,
        areas: [{ bounds: AREA.bounds, action: { type: 'uri', label: 'go' } }],
      }),
    ).toThrow();

    expect(() =>
      CreateRichMenuTemplateDto.schema.parse({
        ...BASE_BODY,
        areas: [
          {
            bounds: AREA.bounds,
            action: { type: 'uri', label: 'go', uri: 'javascript:alert(1)' },
          },
        ],
      }),
    ).toThrow(/uri must start with/);
  });

  it('accepts every rich menu action type LINE supports', () => {
    const actions = [
      { type: 'postback', data: 'action=contact_admin' },
      { type: 'message', text: 'คำถามที่พบบ่อย' },
      { type: 'uri', uri: 'https://liff.line.me/LIFF_ID/orders' },
      { type: 'datetimepicker', data: 'action=book', mode: 'datetime' },
      { type: 'richmenuswitch', richMenuAliasId: 'tab-b', data: 'tab=b' },
      { type: 'camera' },
    ];

    for (const action of actions) {
      expect(() =>
        CreateRichMenuTemplateDto.schema.parse({
          ...BASE_BODY,
          areas: [{ bounds: AREA.bounds, action }],
        }),
      ).not.toThrow();
    }
  });

  it('requires at least one field on update', () => {
    expect(() => UpdateRichMenuTemplateDto.schema.parse({})).toThrow(
      /At least one field is required/,
    );
    expect(
      UpdateRichMenuTemplateDto.schema.parse({ chatBarText: 'เมนู' }),
    ).toEqual({ chatBarText: 'เมนู' });
  });

  it('caps chatBarText at the 14 characters LINE allows', () => {
    expect(() =>
      CreateRichMenuTemplateDto.schema.parse({
        ...BASE_BODY,
        chatBarText: 'x'.repeat(15),
      }),
    ).toThrow();
  });
});
