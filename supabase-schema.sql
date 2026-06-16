-- ============================================================
-- RUG OR RICHES — Supabase (PostgreSQL) Production Schema
-- ============================================================
-- Run this entire file in the Supabase SQL Editor.
-- It creates all tables needed to fully persist the moontap.html
-- game state server-side.
-- ============================================================

-- Enable UUID extension (Supabase usually has this, but be safe)
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ============================================================
-- 1. PLAYERS TABLE
-- Fully persists every field from moontap.html's S state object.
-- Primary key is the Telegram User ID (authoritative identity).
-- ============================================================
CREATE TABLE public.players (
    id              BIGINT PRIMARY KEY,                          -- Telegram User ID
    username        VARCHAR(100),
    first_name      VARCHAR(100),
    balance         BIGINT          DEFAULT 500    NOT NULL,     -- $MOON soft currency
    airdrop_pts     BIGINT          DEFAULT 500    NOT NULL,     -- Airdrop Points
    lifetime_banked BIGINT          DEFAULT 0      NOT NULL,
    best_pot        BIGINT          DEFAULT 0      NOT NULL,
    best_price      DOUBLE PRECISION DEFAULT 1.0   NOT NULL,
    rugs            INT             DEFAULT 0      NOT NULL,
    cashouts        INT             DEFAULT 0      NOT NULL,
    taps            BIGINT          DEFAULT 0      NOT NULL,
    vip_tier        INT             DEFAULT 0      NOT NULL,     -- 0=None 1=Bronze 2=Silver 3=Gold 4=Diamond
    vip_day         DATE,                                        -- last VIP lounge daily claim
    combo_day       DATE,                                        -- last Daily Combo claim
    last_day        DATE,                                        -- last daily streak claim
    energy          DOUBLE PRECISION DEFAULT 100.0 NOT NULL,
    last_energy_sync TIMESTAMPTZ    DEFAULT now()  NOT NULL,
    streak          INT             DEFAULT 1      NOT NULL,
    last_streak_claim DATE,
    stars_spent     INT             DEFAULT 0      NOT NULL,
    -- bet settings (persisted across sessions)
    bet             INT             DEFAULT 100    NOT NULL,
    bet_cur         VARCHAR(10)     DEFAULT 'moon' NOT NULL,     -- 'moon' or 'pts'
    auto_sell       DOUBLE PRECISION DEFAULT 0     NOT NULL,     -- 0 = off, else target multiplier
    stop_loss       INT             DEFAULT 0      NOT NULL,     -- 0 = off, else % from peak
    -- referral
    ref_code        VARCHAR(10)     UNIQUE         NOT NULL,
    referred_by     BIGINT          REFERENCES public.players(id) ON DELETE SET NULL,
    crew_id         UUID,
    sound           BOOLEAN         DEFAULT TRUE   NOT NULL,
    name            VARCHAR(18),                                 -- display name
    starter_bought  BOOLEAN         DEFAULT FALSE  NOT NULL,
    season_pass     BOOLEAN         DEFAULT FALSE  NOT NULL,
    season_claim_day DATE,
    vip_sub_until   BIGINT          DEFAULT 0      NOT NULL,
    first_buy_used  BOOLEAN         DEFAULT FALSE  NOT NULL,
    deal_day        DATE,
    piggy           BIGINT          DEFAULT 0      NOT NULL,
    coin_level      INT             DEFAULT 1      NOT NULL,
    coin_xp         INT             DEFAULT 0      NOT NULL,
    skin            VARCHAR(40)     DEFAULT 'gold',
    skins           JSONB           DEFAULT '["gold"]'::jsonb,
    war_week        VARCHAR(20),
    war_score       BIGINT          DEFAULT 0      NOT NULL,
    war_claim       BOOLEAN         DEFAULT FALSE  NOT NULL,
    created_at      TIMESTAMPTZ     DEFAULT now()  NOT NULL
);

-- Indexes
CREATE INDEX idx_players_lifetime ON public.players (lifetime_banked DESC);
CREATE INDEX idx_players_ref_code ON public.players (ref_code);

-- ============================================================
-- 2. UPGRADES TABLE
-- One row per player, mirrors S.up from moontap.html.
-- ============================================================
CREATE TABLE public.upgrades (
    player_id BIGINT PRIMARY KEY REFERENCES public.players(id) ON DELETE CASCADE,
    power     INT DEFAULT 0 NOT NULL,
    energy    INT DEFAULT 0 NOT NULL,
    regen     INT DEFAULT 0 NOT NULL,
    insure    INT DEFAULT 0 NOT NULL,
    auto      INT DEFAULT 0 NOT NULL,
    combo     INT DEFAULT 0 NOT NULL,
    vault     INT DEFAULT 0 NOT NULL,
    cashbonus INT DEFAULT 0 NOT NULL
);

-- ============================================================
-- 3. QUESTS TABLE
-- Daily quest progress + social follow states.
-- Social booleans are permanent (Follow → Verify → Claim is
-- transient/client-side; once claimed, it stays claimed).
-- ============================================================
CREATE TABLE public.quests (
    player_id       BIGINT PRIMARY KEY REFERENCES public.players(id) ON DELETE CASCADE,
    social_x        BOOLEAN          DEFAULT FALSE        NOT NULL,
    social_tg       BOOLEAN          DEFAULT FALSE        NOT NULL,
    social_tg_group BOOLEAN          DEFAULT FALSE        NOT NULL,
    social_ig       BOOLEAN          DEFAULT FALSE        NOT NULL,
    social_x_state  INT              DEFAULT 0            NOT NULL,
    social_tg_state INT              DEFAULT 0            NOT NULL,
    social_tg_group_state INT        DEFAULT 0            NOT NULL,
    social_ig_state INT              DEFAULT 0            NOT NULL,
    daily_taps      INT              DEFAULT 0            NOT NULL,
    daily_max_price DOUBLE PRECISION DEFAULT 1.0          NOT NULL,
    daily_big_sell  BIGINT           DEFAULT 0            NOT NULL,
    daily_invites   INT              DEFAULT 0            NOT NULL,
    claimed_ids     TEXT[]           DEFAULT '{}'          NOT NULL,  -- quest IDs claimed today
    last_quest_reset DATE            DEFAULT CURRENT_DATE NOT NULL
);

-- ============================================================
-- 4. ACHIEVEMENTS TABLE
-- Composite PK so each achievement can only be unlocked once.
-- ============================================================
CREATE TABLE public.achievements (
    player_id      BIGINT      NOT NULL REFERENCES public.players(id) ON DELETE CASCADE,
    achievement_id VARCHAR(50) NOT NULL,   -- 'first','diamond','whale','moon','streak7','social','vip','shark'
    unlocked_at    TIMESTAMPTZ DEFAULT now() NOT NULL,
    PRIMARY KEY (player_id, achievement_id)
);

-- ============================================================
-- 5. FRIENDS TABLE
-- Tracks referral relationships (who invited whom).
-- ============================================================
CREATE TABLE public.friends (
    player_id  BIGINT  NOT NULL REFERENCES public.players(id) ON DELETE CASCADE,
    friend_id  BIGINT  NOT NULL REFERENCES public.players(id) ON DELETE CASCADE,
    is_premium BOOLEAN DEFAULT FALSE NOT NULL,
    created_at TIMESTAMPTZ DEFAULT now() NOT NULL,
    PRIMARY KEY (player_id, friend_id)
);

-- ============================================================
-- 6. REFERRAL MILESTONES
-- Tracks which milestone tiers (1, 3, 5, 10, 25 friends) have
-- been claimed so rewards aren't double-granted.
-- ============================================================
CREATE TABLE public.ref_milestones (
    player_id   BIGINT NOT NULL REFERENCES public.players(id) ON DELETE CASCADE,
    milestone_n INT    NOT NULL,   -- 1, 3, 5, 10, 25
    claimed_at  TIMESTAMPTZ DEFAULT now() NOT NULL,
    PRIMARY KEY (player_id, milestone_n)
);

-- ============================================================
-- 7. STARS TRANSACTIONS
-- Ledger for Telegram Stars purchases.
-- PK = provider_payment_charge_id → idempotent (INSERT fails
-- on retry = no double-credit).
-- ============================================================
CREATE TABLE public.stars_transactions (
    id           VARCHAR(255) PRIMARY KEY,                          -- provider_payment_charge_id
    player_id    BIGINT NOT NULL REFERENCES public.players(id) ON DELETE CASCADE,
    payer_tg_id  BIGINT NOT NULL,                                   -- update.message.from.id (actual payer)
    stars_amount INT    NOT NULL,
    payload      JSONB  NOT NULL,
    status       VARCHAR(50) DEFAULT 'completed' NOT NULL,
    created_at   TIMESTAMPTZ DEFAULT now() NOT NULL
);

-- ============================================================
-- 8. CREWS TABLE
-- ============================================================
CREATE TABLE public.crews (
    id         UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name       VARCHAR(50) UNIQUE NOT NULL,
    leader_id  BIGINT REFERENCES public.players(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ DEFAULT now() NOT NULL
);

-- Foreign key: players → crews
ALTER TABLE public.players
    ADD CONSTRAINT fk_players_crew
    FOREIGN KEY (crew_id) REFERENCES public.crews(id) ON DELETE SET NULL;
