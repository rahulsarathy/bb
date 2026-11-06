CREATE TABLE IF NOT EXISTS `thread_purges` (
	`thread_id` text PRIMARY KEY NOT NULL,
	`requested_at` integer NOT NULL,
	`retry_at` integer NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`last_error` text,
	FOREIGN KEY (`thread_id`) REFERENCES `threads`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `thread_purges_retry_idx` ON `thread_purges` (`retry_at`,`requested_at`);