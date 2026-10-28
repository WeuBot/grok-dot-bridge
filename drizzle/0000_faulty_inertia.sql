CREATE TABLE `deliveries` (
	`id` text PRIMARY KEY NOT NULL,
	`owner` text NOT NULL,
	`message_id` text NOT NULL,
	`subscription_id` text NOT NULL,
	`state` text NOT NULL,
	`attempts` integer NOT NULL,
	`next_at` integer NOT NULL,
	`lease_until` integer NOT NULL,
	`status` integer,
	`reason` text
);
--> statement-breakpoint
CREATE INDEX `delivery_owner_due` ON `deliveries` (`owner`,`state`,`next_at`);--> statement-breakpoint
CREATE TABLE `messages` (
	`id` text PRIMARY KEY NOT NULL,
	`owner` text NOT NULL,
	`external_id` text NOT NULL,
	`channel` text NOT NULL,
	`body` text NOT NULL,
	`body_hash` text NOT NULL,
	`created_at` integer NOT NULL,
	`result` text,
	`result_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `message_owner_external` ON `messages` (`owner`,`external_id`);--> statement-breakpoint
CREATE INDEX `message_owner_time` ON `messages` (`owner`,`created_at`);--> statement-breakpoint
CREATE TABLE `protocol_log` (
	`id` text PRIMARY KEY NOT NULL,
	`owner` text NOT NULL,
	`method` text NOT NULL,
	`outcome` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `rate_buckets` (
	`id` text PRIMARY KEY NOT NULL,
	`count` integer NOT NULL,
	`expires_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `subscriptions` (
	`id` text PRIMARY KEY NOT NULL,
	`owner` text NOT NULL,
	`channel` text NOT NULL,
	`callback` text NOT NULL,
	`secret` text NOT NULL,
	`old_secret` text,
	`rotation_until` integer,
	`expires_at` integer NOT NULL,
	`verified_at` integer NOT NULL,
	`active` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `subscription_owner` ON `subscriptions` (`owner`,`active`);