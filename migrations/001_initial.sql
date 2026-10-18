CREATE TABLE users (
 id CHAR(36) PRIMARY KEY, email VARCHAR(254) NOT NULL UNIQUE, password_hash VARCHAR(255) NOT NULL,
 verified_at DATETIME(3), created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
 balance INT NOT NULL DEFAULT 3, reserved INT NOT NULL DEFAULT 0,
 deletion_requested_at DATETIME(3), deleted_at DATETIME(3), CHECK (reserved >= 0)
) ENGINE=InnoDB;

CREATE TABLE sessions (
 digest CHAR(64) PRIMARY KEY, user_id CHAR(36) NOT NULL, csrf_digest CHAR(64) NOT NULL,
 created_at DATETIME(3) NOT NULL, expires_at DATETIME(3) NOT NULL, revoked_at DATETIME(3),
 INDEX(user_id), INDEX(expires_at), FOREIGN KEY(user_id) REFERENCES users(id)
) ENGINE=InnoDB;

CREATE TABLE challenges (
 id CHAR(36) PRIMARY KEY, user_id CHAR(36) NOT NULL, kind ENUM('verify','reset') NOT NULL,
 digest CHAR(64) NOT NULL, expires_at DATETIME(3) NOT NULL, used_at DATETIME(3), attempts INT NOT NULL DEFAULT 0,
 created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
 INDEX(user_id, kind, created_at), FOREIGN KEY(user_id) REFERENCES users(id)
) ENGINE=InnoDB;

CREATE TABLE email_outbox (
 id CHAR(36) PRIMARY KEY, user_id CHAR(36) NOT NULL, payload TEXT, attempts INT NOT NULL DEFAULT 0,
 available_at DATETIME(3) NOT NULL, expires_at DATETIME(3) NOT NULL, delivered_at DATETIME(3),
 failed_at DATETIME(3), last_error VARCHAR(60), lease_until DATETIME(3), lease_token CHAR(36),
 INDEX(available_at), FOREIGN KEY(user_id) REFERENCES users(id)
) ENGINE=InnoDB;

CREATE TABLE app_control (
 id INT PRIMARY KEY, paused BOOLEAN NOT NULL DEFAULT FALSE, pause_until DATETIME(3),
 provider_failures INT NOT NULL DEFAULT 0
) ENGINE=InnoDB;
INSERT INTO app_control(id) VALUES(1);

CREATE TABLE jobs (
 id CHAR(36) PRIMARY KEY, user_id CHAR(36) NOT NULL, idempotency_key VARCHAR(100) NOT NULL,
 payload_hash CHAR(64) NOT NULL, input JSON NOT NULL, credit_ref CHAR(36) NOT NULL UNIQUE,
 state ENUM('queued','running','retry_wait','completed','no_colors_found','partial','failed','cancelled','expired') NOT NULL,
 progress JSON NOT NULL, result JSON, failure_code VARCHAR(80),
 created_at DATETIME(3) NOT NULL, waiting_since DATETIME(3) NOT NULL, waited_ms BIGINT NOT NULL DEFAULT 0,
 next_attempt_at DATETIME(3) NOT NULL, attempts INT NOT NULL DEFAULT 0,
 attempt_id CHAR(36), heartbeat_at DATETIME(3), execution_deadline DATETIME(3),
 ended_at DATETIME(3), history_expires_at DATETIME(3), researcher_version VARCHAR(100) NOT NULL,
 run_config JSON NOT NULL, UNIQUE(user_id,idempotency_key), INDEX(state,next_attempt_at),
 INDEX(user_id,created_at), INDEX(history_expires_at), FOREIGN KEY(user_id) REFERENCES users(id)
) ENGINE=InnoDB;

CREATE TABLE research_outbox (
 job_id CHAR(36) PRIMARY KEY, dispatched_at DATETIME(3), created_at DATETIME(3) NOT NULL,
 FOREIGN KEY(job_id) REFERENCES jobs(id) ON DELETE CASCADE
) ENGINE=InnoDB;

CREATE TABLE job_keys (
 user_id CHAR(36) NOT NULL, idempotency_key VARCHAR(100) NOT NULL, job_id CHAR(36),
 PRIMARY KEY(user_id,idempotency_key), FOREIGN KEY(user_id) REFERENCES users(id),
 FOREIGN KEY(job_id) REFERENCES jobs(id) ON DELETE SET NULL
) ENGINE=InnoDB;

CREATE TABLE attempts (
 id CHAR(36) PRIMARY KEY, job_id CHAR(36) NOT NULL, number INT NOT NULL,
 started_at DATETIME(3) NOT NULL, ended_at DATETIME(3), deadline DATETIME(3) NOT NULL,
 known_cost_micro_usd BIGINT, reserved_cost_micro_usd BIGINT NOT NULL, cost_complete BOOLEAN NOT NULL DEFAULT FALSE,
 failure_code VARCHAR(80), UNIQUE(job_id,number), FOREIGN KEY(job_id) REFERENCES jobs(id) ON DELETE CASCADE
) ENGINE=InnoDB;

CREATE TABLE settlements (
 job_id CHAR(36) PRIMARY KEY, treatment ENUM('consumed','released') NOT NULL, created_at DATETIME(3) NOT NULL,
 FOREIGN KEY(job_id) REFERENCES jobs(id) ON DELETE CASCADE
) ENGINE=InnoDB;

CREATE TABLE ledger (
 id BIGINT AUTO_INCREMENT PRIMARY KEY, user_id CHAR(36) NOT NULL,
 kind ENUM('grant','purchase','reservation','consumption','release','reversal','dispute_hold','dispute_restore') NOT NULL,
 balance_delta INT NOT NULL, reserved_delta INT NOT NULL, reference VARCHAR(150) NOT NULL,
 created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), UNIQUE(reference), INDEX(user_id,id),
 FOREIGN KEY(user_id) REFERENCES users(id)
) ENGINE=InnoDB;

CREATE TABLE spending_periods (
 period DATE PRIMARY KEY, allocated_micro_usd BIGINT NOT NULL DEFAULT 0
) ENGINE=InnoDB;

CREATE TABLE purchases (
 id CHAR(36) PRIMARY KEY, user_id CHAR(36) NOT NULL, idempotency_key VARCHAR(100) NOT NULL,
 pack_id VARCHAR(30) NOT NULL, credits INT NOT NULL, amount INT NOT NULL, currency CHAR(3) NOT NULL,
 price_id VARCHAR(150) NOT NULL, session_id VARCHAR(150) UNIQUE, payment_id VARCHAR(150) UNIQUE,
 checkout_url TEXT, state ENUM('pending','fulfilled','expired','review') NOT NULL DEFAULT 'pending',
 refunded_credits INT NOT NULL DEFAULT 0, disputed_credits INT NOT NULL DEFAULT 0, withheld_credits INT NOT NULL DEFAULT 0,
 adjustment_version INT NOT NULL DEFAULT 0, created_at DATETIME(3) NOT NULL,
 fulfilled_at DATETIME(3), reconciled_at DATETIME(3), UNIQUE(user_id,idempotency_key), INDEX(reconciled_at),
 FOREIGN KEY(user_id) REFERENCES users(id)
) ENGINE=InnoDB;

CREATE TABLE stripe_events (
 id VARCHAR(150) PRIMARY KEY, type VARCHAR(100) NOT NULL, object_id VARCHAR(150) NOT NULL,
 created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), processed_at DATETIME(3),
 attempts INT NOT NULL DEFAULT 0, available_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), last_error VARCHAR(60)
) ENGINE=InnoDB;

CREATE TABLE refund_allocations (
 refund_id VARCHAR(150) PRIMARY KEY, purchase_id CHAR(36) NOT NULL, credits INT NOT NULL,
 recorded_by VARCHAR(100) NOT NULL, created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
 CHECK(credits >= 0), FOREIGN KEY(purchase_id) REFERENCES purchases(id)
) ENGINE=InnoDB;

CREATE TABLE privacy_requests (
 id CHAR(36) PRIMARY KEY, user_id CHAR(36) NOT NULL, kind ENUM('deletion','correction') NOT NULL,
 details VARCHAR(500), state ENUM('pending','completed') NOT NULL DEFAULT 'pending',
 created_at DATETIME(3) NOT NULL, completed_at DATETIME(3), FOREIGN KEY(user_id) REFERENCES users(id)
) ENGINE=InnoDB;
