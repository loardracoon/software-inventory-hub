-- Phase H8 (client enrollment): a client key can wait for approval. client_call() accepts only 'active' keys, so a
-- pending key reads nothing. A separate migration: a new enum value cannot be used in the transaction that adds it.
alter type public.client_status add value if not exists 'pending';
