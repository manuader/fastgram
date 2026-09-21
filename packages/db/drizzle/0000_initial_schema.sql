CREATE TYPE "public"."acquisition_tier" AS ENUM('A_oauth', 'B_public_api', 'C_page_fetch', 'D_assisted');--> statement-breakpoint
CREATE TYPE "public"."api_key_kind" AS ENUM('workspace', 'partner');--> statement-breakpoint
CREATE TYPE "public"."audio_library" AS ENUM('wall-of-text', 'video-hook');--> statement-breakpoint
CREATE TYPE "public"."automation_slot_failure_reason" AS ENUM('no_unique_content', 'no_demo_video');--> statement-breakpoint
CREATE TYPE "public"."automation_slot_status" AS ENUM('PENDING_GEN', 'GENERATING', 'READY', 'REROLLING', 'FAILED_GEN', 'QUEUED_BUILD', 'BUILDING', 'SCHEDULED', 'FAILED', 'CANCELLED');--> statement-breakpoint
CREATE TYPE "public"."automation_status" AS ENUM('DRAFT', 'GENERATING', 'REVIEW', 'BUILDING', 'ACTIVE', 'COMPLETED', 'CANCELLED', 'FAILED');--> statement-breakpoint
CREATE TYPE "public"."ban_risk_level" AS ENUM('safe', 'caution', 'warning', 'danger');--> statement-breakpoint
CREATE TYPE "public"."brand_source_failure_reason" AS ENUM('not_found', 'private', 'insufficient_content', 'rate_limited', 'provider_unavailable', 'unsupported_platform', 'already_registered');--> statement-breakpoint
CREATE TYPE "public"."brand_source_status" AS ENUM('pending', 'analyzing', 'ready', 'partial', 'failed', 'stale');--> statement-breakpoint
CREATE TYPE "public"."brand_source_type" AS ENUM('website', 'instagram', 'tiktok', 'x', 'youtube', 'linkedin', 'other_url', 'manual');--> statement-breakpoint
CREATE TYPE "public"."caption_adjustment_reason" AS ENUM('repeated_mention');--> statement-breakpoint
CREATE TYPE "public"."company_profile_status" AS ENUM('pending', 'ready', 'failed', 'partial');--> statement-breakpoint
CREATE TYPE "public"."company_status" AS ENUM('draft', 'preparing', 'active', 'soft_deleted');--> statement-breakpoint
CREATE TYPE "public"."connection_status" AS ENUM('active', 'expired', 'paused', 'revoked');--> statement-breakpoint
CREATE TYPE "public"."content_status" AS ENUM('BUILDING', 'CREATED', 'FAILED');--> statement-breakpoint
CREATE TYPE "public"."content_type" AS ENUM('slideshow', 'wall-of-text', 'green-screen', 'video-hook', 'custom');--> statement-breakpoint
CREATE TYPE "public"."decision_point" AS ENUM('DP-001', 'DP-002', 'DP-003', 'DP-004', 'DP-005', 'DP-006', 'DP-007');--> statement-breakpoint
CREATE TYPE "public"."gender_filter" AS ENUM('man', 'woman');--> statement-breakpoint
CREATE TYPE "public"."idempotency_state" AS ENUM('in_flight', 'completed', 'released');--> statement-breakpoint
CREATE TYPE "public"."influencer_asset_kind" AS ENUM('image', 'video');--> statement-breakpoint
CREATE TYPE "public"."influencer_status" AS ENUM('generating_variations', 'training', 'ready', 'failed', 'inactive');--> statement-breakpoint
CREATE TYPE "public"."instagram_slideshow_format" AS ENUM('carousel', 'reel');--> statement-breakpoint
CREATE TYPE "public"."judgment_adapter" AS ENUM('llm', 'jev', 'stub');--> statement-breakpoint
CREATE TYPE "public"."media_origin" AS ENUM('manual_upload', 'generated', 'demo', 'internal');--> statement-breakpoint
CREATE TYPE "public"."media_set_kind" AS ENUM('SLIDESHOW', 'VIDEO', 'CURATED');--> statement-breakpoint
CREATE TYPE "public"."media_status" AS ENUM('processing', 'ready', 'failed');--> statement-breakpoint
CREATE TYPE "public"."media_type" AS ENUM('image', 'video');--> statement-breakpoint
CREATE TYPE "public"."membership_role" AS ENUM('owner', 'member');--> statement-breakpoint
CREATE TYPE "public"."membership_status" AS ENUM('invited', 'active', 'removed');--> statement-breakpoint
CREATE TYPE "public"."post_account_type" AS ENUM('oauth', 'warmed');--> statement-breakpoint
CREATE TYPE "public"."post_platform" AS ENUM('tiktok', 'instagram', 'youtube', 'reddit', 'linkedin');--> statement-breakpoint
CREATE TYPE "public"."post_status" AS ENUM('BUILDING', 'CREATED', 'SCHEDULED', 'UPLOADING_TO_TIKTOK', 'IN_USER_INBOX', 'POSTED', 'FAILED', 'DELETED', 'AWAITING_RECONNECT', 'CANCELLED');--> statement-breakpoint
CREATE TYPE "public"."posting_availability" AS ENUM('available', 'checking', 'replacement_needed');--> statement-breakpoint
CREATE TYPE "public"."posting_mode" AS ENUM('inbox', 'direct');--> statement-breakpoint
CREATE TYPE "public"."privacy_level" AS ENUM('PUBLIC_TO_EVERYONE', 'MUTUAL_FOLLOW_FRIENDS', 'FOLLOWER_OF_CREATOR', 'SELF_ONLY');--> statement-breakpoint
CREATE TYPE "public"."replacement_decision_status" AS ENUM('pending', 'resolved');--> statement-breakpoint
CREATE TYPE "public"."social_platform" AS ENUM('tiktok', 'instagram', 'youtube', 'linkedin', 'reddit');--> statement-breakpoint
CREATE TYPE "public"."subscription_status" AS ENUM('trialing', 'active', 'past_due', 'canceled');--> statement-breakpoint
CREATE TYPE "public"."suggestion_content_type" AS ENUM('slideshow', 'wall-of-text', 'green-screen', 'video-hook');--> statement-breakpoint
CREATE TYPE "public"."suggestion_status" AS ENUM('queued', 'popped', 'discarded');--> statement-breakpoint
CREATE TYPE "public"."tiktok_sound_mode" AS ENUM('audible', 'silent');--> statement-breakpoint
CREATE TYPE "public"."upload_reservation_state" AS ENUM('reserved', 'finalizing', 'committed', 'failed', 'expired');--> statement-breakpoint
CREATE TYPE "public"."user_deletion_status" AS ENUM('none', 'in_progress', 'rejected');--> statement-breakpoint
CREATE TYPE "public"."warmed_country" AS ENUM('US', 'EU');--> statement-breakpoint
CREATE TYPE "public"."warmed_platform" AS ENUM('tiktok', 'instagram');--> statement-breakpoint
CREATE TABLE "companies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"website_url" text,
	"primary_brand_source_id" uuid,
	"logo_url" text,
	"owner_user_id" uuid NOT NULL,
	"status" "company_status" DEFAULT 'draft' NOT NULL,
	"plan_id" text NOT NULL,
	"subscription_status" "subscription_status" DEFAULT 'trialing' NOT NULL,
	"billing_anchor_day" integer NOT NULL,
	"timezone" text NOT NULL,
	"entitlements" text[] DEFAULT '{}'::text[] NOT NULL,
	"api_overage_enabled" boolean DEFAULT false NOT NULL,
	"partner_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"external_identity_id" text NOT NULL,
	"email" text NOT NULL,
	"full_name" text NOT NULL,
	"timezone" text NOT NULL,
	"default_workspace_id" uuid,
	"deletion_status" "user_deletion_status" DEFAULT 'none' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_full_name_min_len" CHECK (char_length("users"."full_name") >= 2)
);
--> statement-breakpoint
CREATE TABLE "workspace_memberships" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"role" "membership_role" NOT NULL,
	"invited_by" uuid,
	"status" "membership_status" DEFAULT 'invited' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "brand_source_snapshots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"brand_source_id" uuid NOT NULL,
	"company_id" uuid NOT NULL,
	"captured_at" timestamp with time zone DEFAULT now() NOT NULL,
	"tier" "acquisition_tier" NOT NULL,
	"profile_signals" jsonb,
	"content_items" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"derived_fields" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"conflicts" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"raw_retention_expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "brand_sources" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"source_type" "brand_source_type" NOT NULL,
	"handle" text,
	"canonical_url" text,
	"display_name" text,
	"avatar_url" text,
	"is_primary" boolean DEFAULT false NOT NULL,
	"acquisition_tier" "acquisition_tier" NOT NULL,
	"connection_id" uuid,
	"status" "brand_source_status" DEFAULT 'pending' NOT NULL,
	"failure_reason" "brand_source_failure_reason",
	"last_analysed_at" timestamp with time zone,
	"analysis_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "company_profiles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"core_identity" text,
	"product_offering" text,
	"unique_benefits" text,
	"problem_solution" text,
	"market_and_competition" text,
	"tone_of_voice" text,
	"target_audience" text,
	"business_model" text,
	"business_categories" text[] DEFAULT '{}'::text[] NOT NULL,
	"monthly_revenue_band" text,
	"team_size" text,
	"owner_role" text,
	"expectations" text[] DEFAULT '{}'::text[] NOT NULL,
	"brand_revision" integer DEFAULT 0 NOT NULL,
	"status" "company_profile_status" DEFAULT 'pending' NOT NULL,
	"field_meta" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "blitz_preferences" (
	"company_id" uuid PRIMARY KEY NOT NULL,
	"slideshow_weight" integer NOT NULL,
	"wall_of_text_weight" integer NOT NULL,
	"green_screen_weight" integer NOT NULL,
	"video_hook_weight" integer NOT NULL,
	"remix_percentage" integer NOT NULL,
	"own_media_percentage" integer NOT NULL,
	"mention_business_percentage" integer NOT NULL,
	"influencer_chance" integer NOT NULL,
	"smart_text_positioning" boolean DEFAULT false NOT NULL,
	"gender_filter" "gender_filter",
	"angle_weights" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"text_style_weights" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "blitz_preferences_format_weights_sum" CHECK ("blitz_preferences"."slideshow_weight" + "blitz_preferences"."wall_of_text_weight" + "blitz_preferences"."green_screen_weight" + "blitz_preferences"."video_hook_weight" = 100),
	CONSTRAINT "blitz_preferences_percentage_ranges" CHECK ("blitz_preferences"."remix_percentage" between 0 and 100
          and "blitz_preferences"."own_media_percentage" between 0 and 100
          and "blitz_preferences"."mention_business_percentage" between 0 and 100
          and "blitz_preferences"."influencer_chance" between 0 and 100),
	CONSTRAINT "blitz_preferences_format_weights_non_negative" CHECK ("blitz_preferences"."slideshow_weight" >= 0 and "blitz_preferences"."wall_of_text_weight" >= 0
          and "blitz_preferences"."green_screen_weight" >= 0 and "blitz_preferences"."video_hook_weight" >= 0)
);
--> statement-breakpoint
CREATE TABLE "content_angles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"title" varchar(200) NOT NULL,
	"description" varchar(2000),
	"target_audience" varchar(500),
	"is_active" boolean DEFAULT true NOT NULL,
	"influencer_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "suggestions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"content_type" "suggestion_content_type" NOT NULL,
	"generated_text" text,
	"ai_explanation" text,
	"remix_source_url" text,
	"source_trending_item_id" uuid,
	"influencer_id" uuid,
	"angle_id" uuid,
	"text_style_preset_id" text,
	"status" "suggestion_status" DEFAULT 'queued' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "content_text_boxes" (
	"id" text NOT NULL,
	"content_id" uuid NOT NULL,
	"company_id" uuid NOT NULL,
	"slide_index" integer,
	"text" varchar(5000) NOT NULL,
	"position" jsonb NOT NULL,
	"width_percent" integer NOT NULL,
	"font" jsonb NOT NULL,
	"color" text NOT NULL,
	"stroke" jsonb NOT NULL,
	"background" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "content_text_boxes_content_id_id_pk" PRIMARY KEY("content_id","id"),
	CONSTRAINT "content_text_boxes_position_range" CHECK (("content_text_boxes"."position"->>'x')::numeric between 0 and 100
          and ("content_text_boxes"."position"->>'y')::numeric between 0 and 100),
	CONSTRAINT "content_text_boxes_width_percent_range" CHECK ("content_text_boxes"."width_percent" between 25 and 100),
	CONSTRAINT "content_text_boxes_font_size_range" CHECK (("content_text_boxes"."font"->>'size')::numeric between 8 and 72),
	CONSTRAINT "content_text_boxes_stroke_width_range" CHECK (("content_text_boxes"."stroke"->>'width')::numeric between 0 and 8),
	CONSTRAINT "content_text_boxes_background_shape" CHECK ("content_text_boxes"."background" is null
          or (("content_text_boxes"."background"->>'opacity')::numeric between 0 and 1
              and "content_text_boxes"."background"->>'style' in ('pill', 'full-width'))),
	CONSTRAINT "content_text_boxes_color_hex" CHECK ("content_text_boxes"."color" ~ '^#[0-9A-Fa-f]{6}$')
);
--> statement-breakpoint
CREATE TABLE "contents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"type" "content_type" NOT NULL,
	"status" "content_status" DEFAULT 'BUILDING' NOT NULL,
	"files" text[] DEFAULT '{}'::text[] NOT NULL,
	"thumbnail_url" text,
	"generated_text" varchar(2000),
	"remix_source_url" text,
	"revision" integer DEFAULT 1 NOT NULL,
	"build_payload" jsonb,
	"studio_state" jsonb,
	"last_edit" jsonb,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "contents_revision_positive" CHECK ("contents"."revision" >= 1),
	CONSTRAINT "contents_files_max_slides" CHECK (cardinality("contents"."files") <= 20)
);
--> statement-breakpoint
CREATE TABLE "audio_tracks" (
	"audio_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"url" text NOT NULL,
	"description" text NOT NULL,
	"size_mb" real NOT NULL,
	"duration_sec" integer,
	"library" "audio_library" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "media" (
	"media_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"media_type" "media_type" NOT NULL,
	"filename" text NOT NULL,
	"r2_url" text NOT NULL,
	"storage_key" text NOT NULL,
	"status" "media_status" DEFAULT 'processing' NOT NULL,
	"size_mb" real NOT NULL,
	"video_duration_sec" integer,
	"categories" text[] DEFAULT '{}'::text[] NOT NULL,
	"origin" "media_origin" NOT NULL,
	"uploaded_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "media_sets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"name" text NOT NULL,
	"kind" "media_set_kind" NOT NULL,
	"influencer_id" uuid,
	"media_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "influencer_assets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"influencer_id" uuid NOT NULL,
	"company_id" uuid NOT NULL,
	"kind" "influencer_asset_kind" NOT NULL,
	"url" text NOT NULL,
	"prompt" text,
	"model" text,
	"aspect" text,
	"resolution" text,
	"batch" text,
	"credits_spent" integer DEFAULT 0 NOT NULL,
	"duration_sec" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "influencer_configs" (
	"influencer_id" uuid PRIMARY KEY NOT NULL,
	"company_id" uuid NOT NULL,
	"angle_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"publishing_accounts" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"slideshow_set_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"video_set_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "influencers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"name" text NOT NULL,
	"gender" text NOT NULL,
	"age" integer NOT NULL,
	"ethnicity" text NOT NULL,
	"base_image_url" text,
	"status" "influencer_status" DEFAULT 'generating_variations' NOT NULL,
	"progress" integer DEFAULT 0 NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"soul_id" text,
	"base_character_cml_id" text,
	"internal_refs" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "influencers_age_range" CHECK ("influencers"."age" between 18 and 60),
	CONSTRAINT "influencers_progress_range" CHECK ("influencers"."progress" between 0 and 100)
);
--> statement-breakpoint
CREATE TABLE "connections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"platform" "social_platform" NOT NULL,
	"platform_user_id" text NOT NULL,
	"platform_username" text NOT NULL,
	"scopes" text[] DEFAULT '{}'::text[] NOT NULL,
	"publishable" boolean DEFAULT false NOT NULL,
	"token_expiry" timestamp with time zone,
	"access_token" text,
	"refresh_token" text,
	"status" "connection_status" DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "posts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"content_id" uuid NOT NULL,
	"platform" "post_platform" NOT NULL,
	"account_type" "post_account_type" NOT NULL,
	"connection_id" uuid,
	"warmed_account_id" uuid,
	"connection_username" text,
	"scheduled_at_utc" timestamp with time zone NOT NULL,
	"caption" text,
	"description" text,
	"published_caption" text,
	"caption_adjustment_reason" "caption_adjustment_reason",
	"posting_mode" "posting_mode",
	"privacy_level" "privacy_level",
	"disclose_as_ads" boolean,
	"ai_content_disclaimer" boolean,
	"instagram_slideshow_format" "instagram_slideshow_format",
	"tiktok_sound_mode" "tiktok_sound_mode",
	"tiktok_sound_id" text,
	"status" "post_status" DEFAULT 'SCHEDULED' NOT NULL,
	"cancellation_pending" boolean DEFAULT false NOT NULL,
	"tiktok_processing_delayed" boolean DEFAULT false NOT NULL,
	"error_code" text,
	"error_message" text,
	"post_url" text,
	"posted_at" timestamp with time zone,
	"views" integer DEFAULT 0 NOT NULL,
	"likes" integer DEFAULT 0 NOT NULL,
	"comments" integer DEFAULT 0 NOT NULL,
	"automation_slot_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "posts_account_exclusive" CHECK (num_nonnulls("posts"."connection_id", "posts"."warmed_account_id") = 1),
	CONSTRAINT "posts_account_type_matches" CHECK (("posts"."account_type" = 'oauth' and "posts"."connection_id" is not null)
          or ("posts"."account_type" = 'warmed' and "posts"."warmed_account_id" is not null)),
	CONSTRAINT "posts_warmed_platform_supported" CHECK ("posts"."account_type" <> 'warmed' or "posts"."platform" in ('tiktok', 'instagram'))
);
--> statement-breakpoint
CREATE TABLE "replacement_decisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"warmed_account_id" uuid NOT NULL,
	"options" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"status" "replacement_decision_status" DEFAULT 'pending' NOT NULL,
	"decided_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "warmed_accounts" (
	"warmed_account_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"account_type" text DEFAULT 'warmed' NOT NULL,
	"platform" "warmed_platform" NOT NULL,
	"username" text NOT NULL,
	"display_name" text,
	"profile_picture_url" text,
	"status" text NOT NULL,
	"postable" boolean DEFAULT false NOT NULL,
	"posting_availability" "posting_availability" DEFAULT 'checking' NOT NULL,
	"min_lead_time_ms" bigint NOT NULL,
	"country" "warmed_country" NOT NULL,
	"niche" text,
	"keywords" text[] DEFAULT '{}'::text[] NOT NULL,
	"approved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "warmed_accounts_account_type" CHECK ("warmed_accounts"."account_type" = 'warmed')
);
--> statement-breakpoint
CREATE TABLE "warmed_slot_balances" (
	"company_id" uuid PRIMARY KEY NOT NULL,
	"slot_balance" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "warmed_slot_balances_non_negative" CHECK ("warmed_slot_balances"."slot_balance" >= 0)
);
--> statement-breakpoint
CREATE TABLE "automation_slots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"automation_id" uuid NOT NULL,
	"company_id" uuid NOT NULL,
	"status" "automation_slot_status" DEFAULT 'PENDING_GEN' NOT NULL,
	"content_type" "content_type" NOT NULL,
	"suggestion_data" jsonb,
	"generated_text" text,
	"captions_by_platform" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"scheduled_at_utc" timestamp with time zone,
	"failure_reason" "automation_slot_failure_reason",
	"content_id" uuid,
	"post_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "automations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"name" varchar(100) NOT NULL,
	"status" "automation_status" DEFAULT 'DRAFT' NOT NULL,
	"accounts" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"per_account_per_day" integer NOT NULL,
	"duration_weeks" integer NOT NULL,
	"start_date_utc" timestamp with time zone NOT NULL,
	"timezone" text NOT NULL,
	"posting_mode" "posting_mode",
	"youtube_privacy_status" text,
	"disclose_as_ads" boolean DEFAULT false NOT NULL,
	"ai_content_disclaimer" boolean DEFAULT false NOT NULL,
	"prefs_snapshot" jsonb,
	"generation_quota_used" integer DEFAULT 0 NOT NULL,
	"launch_validation" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "automations_per_account_per_day_range" CHECK ("automations"."per_account_per_day" between 1 and 3),
	CONSTRAINT "automations_duration_weeks_range" CHECK ("automations"."duration_weeks" between 1 and 4)
);
--> statement-breakpoint
CREATE TABLE "ban_risk_assessments" (
	"company_id" uuid PRIMARY KEY NOT NULL,
	"level" "ban_risk_level" NOT NULL,
	"promo_ratio" numeric(5, 4),
	"recommendation" text,
	"computed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "leads" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"reddit_post_id" text NOT NULL,
	"subreddit" text NOT NULL,
	"title" text NOT NULL,
	"body" text,
	"author" text,
	"score" integer DEFAULT 0 NOT NULL,
	"engagement_score" numeric(10, 4),
	"why_this_lead" text,
	"seen_at" timestamp with time zone,
	"replied_at" timestamp with time zone,
	"thread_state" text,
	"generated_reply" text,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "trending_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"platform" "social_platform" NOT NULL,
	"permalink" text NOT NULL,
	"thumbnail_url" text,
	"media_urls" text[] DEFAULT '{}'::text[] NOT NULL,
	"is_slideshow" boolean DEFAULT false NOT NULL,
	"slide_count" integer DEFAULT 0 NOT NULL,
	"views" integer DEFAULT 0 NOT NULL,
	"likes" integer DEFAULT 0 NOT NULL,
	"niches" text[] DEFAULT '{}'::text[] NOT NULL,
	"text_overlays" text[] DEFAULT '{}'::text[] NOT NULL,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "api_keys" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"label" text NOT NULL,
	"hash" text NOT NULL,
	"prefix" text DEFAULT 'fsln_live_' NOT NULL,
	"kind" "api_key_kind" DEFAULT 'workspace' NOT NULL,
	"revoked_at" timestamp with time zone,
	"expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "idempotency_records" (
	"key" text NOT NULL,
	"company_id" uuid NOT NULL,
	"endpoint" text NOT NULL,
	"request_hash" text NOT NULL,
	"response_snapshot" jsonb,
	"state" "idempotency_state" DEFAULT 'in_flight' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "idempotency_records_company_id_key_pk" PRIMARY KEY("company_id","key")
);
--> statement-breakpoint
CREATE TABLE "onboarding_records" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_user_id" uuid NOT NULL,
	"draft_company_id" uuid,
	"step" text NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "quota_ledgers" (
	"company_id" uuid NOT NULL,
	"period" text NOT NULL,
	"content_saves_included" integer DEFAULT 0 NOT NULL,
	"content_saves_used" integer DEFAULT 0 NOT NULL,
	"content_saves_purchased" integer DEFAULT 0 NOT NULL,
	"overage_units" integer DEFAULT 0 NOT NULL,
	"daily_swipes_used" integer DEFAULT 0 NOT NULL,
	"daily_swipe_reset_at" timestamp with time zone,
	"ai_credits" integer DEFAULT 0 NOT NULL,
	"warmed_post_slots" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "quota_ledgers_company_id_period_pk" PRIMARY KEY("company_id","period"),
	CONSTRAINT "quota_ledgers_counters_non_negative" CHECK ("quota_ledgers"."content_saves_included" >= 0 and "quota_ledgers"."content_saves_used" >= 0
          and "quota_ledgers"."content_saves_purchased" >= 0 and "quota_ledgers"."overage_units" >= 0
          and "quota_ledgers"."daily_swipes_used" >= 0 and "quota_ledgers"."ai_credits" >= 0
          and "quota_ledgers"."warmed_post_slots" >= 0)
);
--> statement-breakpoint
CREATE TABLE "upload_reservations" (
	"upload_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"api_key_id" uuid,
	"filename" text NOT NULL,
	"content_type" text NOT NULL,
	"size_bytes" bigint NOT NULL,
	"duration_sec" integer,
	"storage_key" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"state" "upload_reservation_state" DEFAULT 'reserved' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "upload_reservations_size_positive" CHECK ("upload_reservations"."size_bytes" > 0)
);
--> statement-breakpoint
CREATE TABLE "judgment_records" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"decision_point" "decision_point" NOT NULL,
	"subject_type" text NOT NULL,
	"subject_id" text,
	"adapter" "judgment_adapter" NOT NULL,
	"model" text,
	"answers" jsonb NOT NULL,
	"state_hash" text NOT NULL,
	"input_tokens" integer,
	"latency_ms" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "judgment_records_metrics_non_negative" CHECK (("judgment_records"."input_tokens" is null or "judgment_records"."input_tokens" >= 0)
          and ("judgment_records"."latency_ms" is null or "judgment_records"."latency_ms" >= 0))
);
--> statement-breakpoint
ALTER TABLE "companies" ADD CONSTRAINT "companies_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_default_workspace_id_companies_id_fk" FOREIGN KEY ("default_workspace_id") REFERENCES "public"."companies"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_memberships" ADD CONSTRAINT "workspace_memberships_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_memberships" ADD CONSTRAINT "workspace_memberships_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_memberships" ADD CONSTRAINT "workspace_memberships_invited_by_users_id_fk" FOREIGN KEY ("invited_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "brand_source_snapshots" ADD CONSTRAINT "brand_source_snapshots_brand_source_id_brand_sources_id_fk" FOREIGN KEY ("brand_source_id") REFERENCES "public"."brand_sources"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "brand_source_snapshots" ADD CONSTRAINT "brand_source_snapshots_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "brand_sources" ADD CONSTRAINT "brand_sources_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "brand_sources" ADD CONSTRAINT "brand_sources_connection_id_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."connections"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "company_profiles" ADD CONSTRAINT "company_profiles_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "blitz_preferences" ADD CONSTRAINT "blitz_preferences_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "content_angles" ADD CONSTRAINT "content_angles_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "suggestions" ADD CONSTRAINT "suggestions_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "suggestions" ADD CONSTRAINT "suggestions_source_trending_item_id_trending_items_id_fk" FOREIGN KEY ("source_trending_item_id") REFERENCES "public"."trending_items"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "suggestions" ADD CONSTRAINT "suggestions_influencer_id_influencers_id_fk" FOREIGN KEY ("influencer_id") REFERENCES "public"."influencers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "suggestions" ADD CONSTRAINT "suggestions_angle_id_content_angles_id_fk" FOREIGN KEY ("angle_id") REFERENCES "public"."content_angles"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "content_text_boxes" ADD CONSTRAINT "content_text_boxes_content_id_contents_id_fk" FOREIGN KEY ("content_id") REFERENCES "public"."contents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "content_text_boxes" ADD CONSTRAINT "content_text_boxes_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contents" ADD CONSTRAINT "contents_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "media" ADD CONSTRAINT "media_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "media_sets" ADD CONSTRAINT "media_sets_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "media_sets" ADD CONSTRAINT "media_sets_influencer_id_influencers_id_fk" FOREIGN KEY ("influencer_id") REFERENCES "public"."influencers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "influencer_assets" ADD CONSTRAINT "influencer_assets_influencer_id_influencers_id_fk" FOREIGN KEY ("influencer_id") REFERENCES "public"."influencers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "influencer_assets" ADD CONSTRAINT "influencer_assets_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "influencer_configs" ADD CONSTRAINT "influencer_configs_influencer_id_influencers_id_fk" FOREIGN KEY ("influencer_id") REFERENCES "public"."influencers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "influencer_configs" ADD CONSTRAINT "influencer_configs_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "influencers" ADD CONSTRAINT "influencers_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connections" ADD CONSTRAINT "connections_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "posts" ADD CONSTRAINT "posts_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "posts" ADD CONSTRAINT "posts_content_id_contents_id_fk" FOREIGN KEY ("content_id") REFERENCES "public"."contents"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "posts" ADD CONSTRAINT "posts_connection_id_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."connections"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "posts" ADD CONSTRAINT "posts_warmed_account_id_warmed_accounts_warmed_account_id_fk" FOREIGN KEY ("warmed_account_id") REFERENCES "public"."warmed_accounts"("warmed_account_id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "posts" ADD CONSTRAINT "posts_automation_slot_id_automation_slots_id_fk" FOREIGN KEY ("automation_slot_id") REFERENCES "public"."automation_slots"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "replacement_decisions" ADD CONSTRAINT "replacement_decisions_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "replacement_decisions" ADD CONSTRAINT "replacement_decisions_warmed_account_id_warmed_accounts_warmed_account_id_fk" FOREIGN KEY ("warmed_account_id") REFERENCES "public"."warmed_accounts"("warmed_account_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "replacement_decisions" ADD CONSTRAINT "replacement_decisions_decided_by_user_id_users_id_fk" FOREIGN KEY ("decided_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "warmed_accounts" ADD CONSTRAINT "warmed_accounts_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "warmed_slot_balances" ADD CONSTRAINT "warmed_slot_balances_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_slots" ADD CONSTRAINT "automation_slots_automation_id_automations_id_fk" FOREIGN KEY ("automation_id") REFERENCES "public"."automations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_slots" ADD CONSTRAINT "automation_slots_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_slots" ADD CONSTRAINT "automation_slots_content_id_contents_id_fk" FOREIGN KEY ("content_id") REFERENCES "public"."contents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automations" ADD CONSTRAINT "automations_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ban_risk_assessments" ADD CONSTRAINT "ban_risk_assessments_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leads" ADD CONSTRAINT "leads_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "idempotency_records" ADD CONSTRAINT "idempotency_records_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "onboarding_records" ADD CONSTRAINT "onboarding_records_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "onboarding_records" ADD CONSTRAINT "onboarding_records_draft_company_id_companies_id_fk" FOREIGN KEY ("draft_company_id") REFERENCES "public"."companies"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quota_ledgers" ADD CONSTRAINT "quota_ledgers_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "upload_reservations" ADD CONSTRAINT "upload_reservations_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "upload_reservations" ADD CONSTRAINT "upload_reservations_api_key_id_api_keys_id_fk" FOREIGN KEY ("api_key_id") REFERENCES "public"."api_keys"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "judgment_records" ADD CONSTRAINT "judgment_records_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "companies_website_url_uq" ON "companies" USING btree ("website_url") WHERE "companies"."website_url" is not null;--> statement-breakpoint
CREATE INDEX "companies_owner_created_idx" ON "companies" USING btree ("owner_user_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "users_email_uq" ON "users" USING btree ("email");--> statement-breakpoint
CREATE UNIQUE INDEX "users_external_identity_uq" ON "users" USING btree ("external_identity_id");--> statement-breakpoint
CREATE INDEX "workspace_memberships_company_created_idx" ON "workspace_memberships" USING btree ("company_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "workspace_memberships_company_user_uq" ON "workspace_memberships" USING btree ("company_id","user_id");--> statement-breakpoint
CREATE INDEX "workspace_memberships_user_idx" ON "workspace_memberships" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "brand_source_snapshots_company_created_idx" ON "brand_source_snapshots" USING btree ("company_id","created_at");--> statement-breakpoint
CREATE INDEX "brand_source_snapshots_source_captured_idx" ON "brand_source_snapshots" USING btree ("brand_source_id","captured_at");--> statement-breakpoint
CREATE INDEX "brand_source_snapshots_raw_retention_idx" ON "brand_source_snapshots" USING btree ("raw_retention_expires_at") WHERE "brand_source_snapshots"."raw_retention_expires_at" is not null;--> statement-breakpoint
CREATE INDEX "brand_sources_company_created_idx" ON "brand_sources" USING btree ("company_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "brand_sources_type_handle_uq" ON "brand_sources" USING btree ("source_type","handle") WHERE "brand_sources"."handle" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "brand_sources_primary_uq" ON "brand_sources" USING btree ("company_id") WHERE "brand_sources"."is_primary";--> statement-breakpoint
CREATE UNIQUE INDEX "company_profiles_company_uq" ON "company_profiles" USING btree ("company_id");--> statement-breakpoint
CREATE INDEX "company_profiles_company_created_idx" ON "company_profiles" USING btree ("company_id","created_at");--> statement-breakpoint
CREATE INDEX "content_angles_company_created_idx" ON "content_angles" USING btree ("company_id","created_at");--> statement-breakpoint
CREATE INDEX "suggestions_company_created_idx" ON "suggestions" USING btree ("company_id","created_at");--> statement-breakpoint
CREATE INDEX "suggestions_company_queued_idx" ON "suggestions" USING btree ("company_id","created_at") WHERE "suggestions"."status" = 'queued';--> statement-breakpoint
CREATE INDEX "content_text_boxes_company_created_idx" ON "content_text_boxes" USING btree ("company_id","created_at");--> statement-breakpoint
CREATE INDEX "contents_company_created_idx" ON "contents" USING btree ("company_id","created_at");--> statement-breakpoint
CREATE INDEX "contents_company_live_created_idx" ON "contents" USING btree ("company_id","created_at") WHERE "contents"."deleted_at" is null;--> statement-breakpoint
CREATE INDEX "audio_tracks_library_created_idx" ON "audio_tracks" USING btree ("library","created_at");--> statement-breakpoint
CREATE INDEX "media_company_created_idx" ON "media" USING btree ("company_id","created_at");--> statement-breakpoint
CREATE INDEX "media_company_live_created_idx" ON "media" USING btree ("company_id","created_at") WHERE "media"."deleted_at" is null;--> statement-breakpoint
CREATE INDEX "media_company_uploaded_idx" ON "media" USING btree ("company_id","uploaded_at");--> statement-breakpoint
CREATE INDEX "media_sets_company_created_idx" ON "media_sets" USING btree ("company_id","created_at");--> statement-breakpoint
CREATE INDEX "influencer_assets_company_created_idx" ON "influencer_assets" USING btree ("company_id","created_at");--> statement-breakpoint
CREATE INDEX "influencer_assets_influencer_created_idx" ON "influencer_assets" USING btree ("influencer_id","created_at");--> statement-breakpoint
CREATE INDEX "influencer_configs_company_created_idx" ON "influencer_configs" USING btree ("company_id","created_at");--> statement-breakpoint
CREATE INDEX "influencers_company_created_idx" ON "influencers" USING btree ("company_id","created_at");--> statement-breakpoint
CREATE INDEX "influencers_company_active_idx" ON "influencers" USING btree ("company_id","created_at") WHERE "influencers"."is_active";--> statement-breakpoint
CREATE INDEX "connections_company_created_idx" ON "connections" USING btree ("company_id","created_at");--> statement-breakpoint
CREATE INDEX "connections_company_platform_idx" ON "connections" USING btree ("company_id","platform","status");--> statement-breakpoint
CREATE INDEX "posts_company_created_idx" ON "posts" USING btree ("company_id","created_at");--> statement-breakpoint
CREATE INDEX "posts_company_scheduled_idx" ON "posts" USING btree ("company_id","scheduled_at_utc");--> statement-breakpoint
CREATE INDEX "posts_content_idx" ON "posts" USING btree ("content_id");--> statement-breakpoint
CREATE INDEX "replacement_decisions_company_created_idx" ON "replacement_decisions" USING btree ("company_id","created_at");--> statement-breakpoint
CREATE INDEX "warmed_accounts_company_created_idx" ON "warmed_accounts" USING btree ("company_id","created_at");--> statement-breakpoint
CREATE INDEX "warmed_slot_balances_company_created_idx" ON "warmed_slot_balances" USING btree ("company_id","created_at");--> statement-breakpoint
CREATE INDEX "automation_slots_company_created_idx" ON "automation_slots" USING btree ("company_id","created_at");--> statement-breakpoint
CREATE INDEX "automation_slots_automation_created_idx" ON "automation_slots" USING btree ("automation_id","created_at");--> statement-breakpoint
CREATE INDEX "automations_company_created_idx" ON "automations" USING btree ("company_id","created_at");--> statement-breakpoint
CREATE INDEX "ban_risk_assessments_company_created_idx" ON "ban_risk_assessments" USING btree ("company_id","created_at");--> statement-breakpoint
CREATE INDEX "leads_company_created_idx" ON "leads" USING btree ("company_id","created_at");--> statement-breakpoint
CREATE INDEX "leads_company_live_created_idx" ON "leads" USING btree ("company_id","created_at") WHERE "leads"."deleted_at" is null;--> statement-breakpoint
CREATE INDEX "trending_items_platform_fetched_idx" ON "trending_items" USING btree ("platform","fetched_at");--> statement-breakpoint
CREATE INDEX "trending_items_created_idx" ON "trending_items" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "api_keys_company_created_idx" ON "api_keys" USING btree ("company_id","created_at");--> statement-breakpoint
CREATE INDEX "api_keys_hash_idx" ON "api_keys" USING btree ("hash");--> statement-breakpoint
CREATE INDEX "idempotency_records_company_created_idx" ON "idempotency_records" USING btree ("company_id","created_at");--> statement-breakpoint
CREATE INDEX "onboarding_records_owner_created_idx" ON "onboarding_records" USING btree ("owner_user_id","created_at");--> statement-breakpoint
CREATE INDEX "quota_ledgers_company_created_idx" ON "quota_ledgers" USING btree ("company_id","created_at");--> statement-breakpoint
CREATE INDEX "upload_reservations_company_created_idx" ON "upload_reservations" USING btree ("company_id","created_at");--> statement-breakpoint
CREATE INDEX "upload_reservations_expires_idx" ON "upload_reservations" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "judgment_records_company_created_idx" ON "judgment_records" USING btree ("company_id","created_at");--> statement-breakpoint
CREATE INDEX "judgment_records_decision_state_idx" ON "judgment_records" USING btree ("decision_point","state_hash");--> statement-breakpoint
CREATE INDEX "judgment_records_subject_idx" ON "judgment_records" USING btree ("company_id","subject_type","subject_id");