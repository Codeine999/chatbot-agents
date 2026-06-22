-- Repair existing databases that created LineChatSender before the user sender
-- value was present. Prisma maps LineChatSender.USER to the DB value 'user'.
ALTER TYPE "LineChatSender" ADD VALUE IF NOT EXISTS 'user';
