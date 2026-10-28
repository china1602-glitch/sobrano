CREATE TABLE `catalog_entries` (
	`kind` text NOT NULL,
	`position` integer NOT NULL,
	`row_json` text NOT NULL,
	PRIMARY KEY(`kind`, `position`),
	CONSTRAINT "catalog_kind" CHECK("catalog_entries"."kind" IN ('product','build','offer')),
	CONSTRAINT "catalog_position" CHECK("catalog_entries"."position" >= 0)
);
--> statement-breakpoint
CREATE TABLE `catalog_metadata` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `saved_builds` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`name` text NOT NULL,
	`parts_json` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`request_id` text NOT NULL,
	`request_hash` text NOT NULL,
	FOREIGN KEY (`owner_id`) REFERENCES `visitor_sessions`(`owner_id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "build_name" CHECK(length("saved_builds"."name") BETWEEN 1 AND 80),
	CONSTRAINT "build_version" CHECK("saved_builds"."version">0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `saved_builds_owner_request` ON `saved_builds` (`owner_id`,`request_id`);--> statement-breakpoint
CREATE INDEX `saved_builds_owner_updated` ON `saved_builds` (`owner_id`,`updated_at`);--> statement-breakpoint
CREATE TABLE `visitor_sessions` (
	`owner_id` text PRIMARY KEY NOT NULL,
	`token_hash` text NOT NULL,
	`csrf_token` text NOT NULL,
	`created_at` text NOT NULL,
	`expires_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `visitor_sessions_token_hash_unique` ON `visitor_sessions` (`token_hash`);--> statement-breakpoint
CREATE INDEX `visitor_sessions_expiry` ON `visitor_sessions` (`expires_at`);