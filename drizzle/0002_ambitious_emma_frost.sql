ALTER TABLE `messages` ADD `reply_to` text;--> statement-breakpoint
CREATE UNIQUE INDEX `message_owner_reply` ON `messages` (`owner`,`reply_to`);