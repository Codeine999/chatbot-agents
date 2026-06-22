export type LineWebhookBody = {
  destination: string;
  events: LineWebhookEvent[];
};

export type LineWebhookEvent =
  | LineMessageEvent
  | LineFollowEvent
  | LineUnfollowEvent
  | LinePostbackEvent;

export type LineMessageEvent = {
  type: 'message';
  message: LineMessage;
  webhookEventId: string;
  deliveryContext: {
    isRedelivery: boolean;
  };
  timestamp: number;
  source: LineEventSource;
  replyToken: string;
  mode: 'active' | 'standby';
};

export type LineMessage =
  | {
      type: 'text';
      id: string;
      text: string;
      quoteToken?: string;
    }
  | {
      type: 'image';
      id: string;
      contentProvider?: unknown;
    }
  | {
      type: 'sticker';
      id: string;
      packageId: string;
      stickerId: string;
      stickerResourceType?: string;
    };

export type LineEventSource =
  | {
      type: 'user';
      userId: string;
    }
  | {
      type: 'group';
      groupId: string;
      userId?: string;
    }
  | {
      type: 'room';
      roomId: string;
      userId?: string;
    };

export type LineFollowEvent = {
  type: 'follow';
  replyToken: string;
  source: LineEventSource;
  timestamp: number;
  mode: 'active' | 'standby';
};

export type LineUnfollowEvent = {
  type: 'unfollow';
  source: LineEventSource;
  timestamp: number;
  mode: 'active' | 'standby';
};

export type LinePostbackEvent = {
  type: 'postback';
  replyToken: string;
  source: LineEventSource;
  timestamp: number;
  postback: {
    data: string;
    params?: Record<string, string>;
  };
  mode: 'active' | 'standby';
};
