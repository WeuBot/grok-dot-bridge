CREATE TABLE `grok_outbox` (
	`id` text PRIMARY KEY NOT NULL,
	`owner` text NOT NULL,
	`external_id` text NOT NULL,
	`channel` text NOT NULL,
	`destination_hash` text NOT NULL,
	`body` text NOT NULL,
	`state` text NOT NULL,
	`attempts` integer NOT NULL,
	`next_at` integer NOT NULL,
	`lease_until` integer NOT NULL,
	`claim_token` text,
	`status` integer,
	`reason` text,
	`created_at` integer NOT NULL,
	`accepted_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `grok_owner_message` ON `grok_outbox` (`owner`,`external_id`);--> statement-breakpoint
CREATE INDEX `grok_owner_due` ON `grok_outbox` (`owner`,`state`,`next_at`);