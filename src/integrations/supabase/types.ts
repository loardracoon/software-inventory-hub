
export type Json = string | number | boolean | null | { [key: string]: Json | undefined } | Json[]

export type Database = {
  
  "graphql_public": {
          Tables: {
            [_ in never]: never
          }
          Views: {
            [_ in never]: never
          }
          Functions: {
            "graphql":
{ Args: { "extensions"?: Json,"operationName"?: string,"query"?: string,"variables"?: Json }; Returns: Json
                           }
          }
          Enums: {
            [_ in never]: never
          }
          CompositeTypes: {
            [_ in never]: never
          }
        },"public": {
          Tables: {
            "access_rules": {
                  Row: {
                    "created_at": string,"created_by": string | null,"id": string,"kind": string,"role": Database["public"]['Enums']["hub_role"],"value": string
                  }
                  ComputedFields: never
                  Insert: {
                    "created_at"?: string,"created_by"?: string | null,"id"?: string,"kind": string,"role": Database["public"]['Enums']["hub_role"],"value": string
                  }
                  Update: {
                    "created_at"?: string,"created_by"?: string | null,"id"?: string,"kind"?: string,"role"?: Database["public"]['Enums']["hub_role"],"value"?: string
                  }
                  Relationships: [
                    
                  ]
                },"ai_calls": {
                  Row: {
                    "cache_read_tokens": number,"cache_write_tokens": number,"cost_usd": number,"created_at": string,"engine": string,"entry_ids": (string)[] | null,"error": string | null,"http_status": number | null,"id": number,"input_tokens": number,"latency_ms": number | null,"model": string,"output_tokens": number,"provider": string | null,"purpose": string,"run_id": string | null,"searches": number,"status": string,"titles": number
                  }
                  ComputedFields: never
                  Insert: {
                    "cache_read_tokens"?: number,"cache_write_tokens"?: number,"cost_usd"?: number,"created_at"?: string,"engine": string,"entry_ids"?: (string)[] | null,"error"?: string | null,"http_status"?: number | null,"id"?: never,"input_tokens"?: number,"latency_ms"?: number | null,"model": string,"output_tokens"?: number,"provider"?: string | null,"purpose": string,"run_id"?: string | null,"searches"?: number,"status": string,"titles"?: number
                  }
                  Update: {
                    "cache_read_tokens"?: number,"cache_write_tokens"?: number,"cost_usd"?: number,"created_at"?: string,"engine"?: string,"entry_ids"?: (string)[] | null,"error"?: string | null,"http_status"?: number | null,"id"?: never,"input_tokens"?: number,"latency_ms"?: number | null,"model"?: string,"output_tokens"?: number,"provider"?: string | null,"purpose"?: string,"run_id"?: string | null,"searches"?: number,"status"?: string,"titles"?: number
                  }
                  Relationships: [
                    {
      foreignKeyName: "ai_calls_run_id_fkey"
      columns: ["run_id"]
isOneToOne: false
      referencedRelation: "classification_runs"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "ai_calls_run_id_fkey"
      columns: ["run_id"]
isOneToOne: false
      referencedRelation: "v_runs"
      referencedColumns: ["id"]
    }
                  ]
                },"ai_prices": {
                  Row: {
                    "cache_read_per_mtok": number,"cache_write_per_mtok": number,"effective_from": string,"engine": string,"input_per_mtok": number,"model": string,"output_per_mtok": number,"per_search_usd": number,"provider": string
                  }
                  ComputedFields: never
                  Insert: {
                    "cache_read_per_mtok"?: number,"cache_write_per_mtok"?: number,"effective_from"?: string,"engine": string,"input_per_mtok": number,"model": string,"output_per_mtok": number,"per_search_usd"?: number,"provider"?: string
                  }
                  Update: {
                    "cache_read_per_mtok"?: number,"cache_write_per_mtok"?: number,"effective_from"?: string,"engine"?: string,"input_per_mtok"?: number,"model"?: string,"output_per_mtok"?: number,"per_search_usd"?: number,"provider"?: string
                  }
                  Relationships: [
                    
                  ]
                },"audit_log": {
                  Row: {
                    "action": string,"created_at": string,"data": Json | null,"id": number,"target": string | null,"user_id": string | null
                  }
                  ComputedFields: never
                  Insert: {
                    "action": string,"created_at"?: string,"data"?: Json | null,"id"?: never,"target"?: string | null,"user_id"?: string | null
                  }
                  Update: {
                    "action"?: string,"created_at"?: string,"data"?: Json | null,"id"?: never,"target"?: string | null,"user_id"?: string | null
                  }
                  Relationships: [
                    
                  ]
                },"categories": {
                  Row: {
                    "attention_level": Database["public"]['Enums']["attention_level"] | null,"created_at": string,"deprecated": boolean,"description": string | null,"id": string,"name": string,"parent_id": string | null,"revision": number,"seq": number,"slug": string,"sophos_firewall_category": string | null,"updated_at": string
                  }
                  ComputedFields: never
                  Insert: {
                    "attention_level"?: Database["public"]['Enums']["attention_level"] | null,"created_at"?: string,"deprecated"?: boolean,"description"?: string | null,"id"?: string,"name": string,"parent_id"?: string | null,"revision"?: number,"seq"?: number,"slug": string,"sophos_firewall_category"?: string | null,"updated_at"?: string
                  }
                  Update: {
                    "attention_level"?: Database["public"]['Enums']["attention_level"] | null,"created_at"?: string,"deprecated"?: boolean,"description"?: string | null,"id"?: string,"name"?: string,"parent_id"?: string | null,"revision"?: number,"seq"?: number,"slug"?: string,"sophos_firewall_category"?: string | null,"updated_at"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "categories_parent_id_fkey"
      columns: ["parent_id"]
isOneToOne: false
      referencedRelation: "categories"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "categories_parent_id_fkey"
      columns: ["parent_id"]
isOneToOne: false
      referencedRelation: "v_request_groups"
      referencedColumns: ["current_category_id"]
    }
                  ]
                },"classification_results": {
                  Row: {
                    "accepted": boolean | null,"accepted_at": string | null,"accepted_by": string | null,"category_id": string | null,"entry_id": string,"probability": number | null,"run_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "accepted"?: boolean | null,"accepted_at"?: string | null,"accepted_by"?: string | null,"category_id"?: string | null,"entry_id": string,"probability"?: number | null,"run_id": string
                  }
                  Update: {
                    "accepted"?: boolean | null,"accepted_at"?: string | null,"accepted_by"?: string | null,"category_id"?: string | null,"entry_id"?: string,"probability"?: number | null,"run_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "classification_results_category_id_fkey"
      columns: ["category_id"]
isOneToOne: false
      referencedRelation: "categories"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "classification_results_category_id_fkey"
      columns: ["category_id"]
isOneToOne: false
      referencedRelation: "v_request_groups"
      referencedColumns: ["current_category_id"]
    },{
      foreignKeyName: "classification_results_entry_id_fkey"
      columns: ["entry_id"]
isOneToOne: false
      referencedRelation: "entries"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "classification_results_entry_id_fkey"
      columns: ["entry_id"]
isOneToOne: false
      referencedRelation: "v_request_groups"
      referencedColumns: ["entry_id"]
    },{
      foreignKeyName: "classification_results_run_id_fkey"
      columns: ["run_id"]
isOneToOne: false
      referencedRelation: "classification_runs"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "classification_results_run_id_fkey"
      columns: ["run_id"]
isOneToOne: false
      referencedRelation: "v_runs"
      referencedColumns: ["id"]
    }
                  ]
                },"classification_runs": {
                  Row: {
                    "entry_count": number,"finished_at": string | null,"id": string,"model": string,"rerun": boolean,"started_at": string,"started_by": string | null,"status": Database["public"]['Enums']["run_status"]
                  }
                  ComputedFields: never
                  Insert: {
                    "entry_count"?: number,"finished_at"?: string | null,"id"?: string,"model": string,"rerun"?: boolean,"started_at"?: string,"started_by"?: string | null,"status"?: Database["public"]['Enums']["run_status"]
                  }
                  Update: {
                    "entry_count"?: number,"finished_at"?: string | null,"id"?: string,"model"?: string,"rerun"?: boolean,"started_at"?: string,"started_by"?: string | null,"status"?: Database["public"]['Enums']["run_status"]
                  }
                  Relationships: [
                    
                  ]
                },"client_rate": {
                  Row: {
                    "calls": number,"client_id": string,"minute": string
                  }
                  ComputedFields: never
                  Insert: {
                    "calls"?: number,"client_id": string,"minute": string
                  }
                  Update: {
                    "calls"?: number,"client_id"?: string,"minute"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "client_rate_client_id_fkey"
      columns: ["client_id"]
isOneToOne: false
      referencedRelation: "client_names"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "client_rate_client_id_fkey"
      columns: ["client_id"]
isOneToOne: false
      referencedRelation: "clients"
      referencedColumns: ["id"]
    }
                  ]
                },"clients": {
                  Row: {
                    "contact_email": string,"created_at": string,"id": string,"key_hash": string,"key_prefix": string,"last_seen_at": string | null,"last_seq": number,"name": string,"status": Database["public"]['Enums']["client_status"]
                  }
                  ComputedFields: never
                  Insert: {
                    "contact_email": string,"created_at"?: string,"id"?: string,"key_hash": string,"key_prefix": string,"last_seen_at"?: string | null,"last_seq"?: number,"name": string,"status"?: Database["public"]['Enums']["client_status"]
                  }
                  Update: {
                    "contact_email"?: string,"created_at"?: string,"id"?: string,"key_hash"?: string,"key_prefix"?: string,"last_seen_at"?: string | null,"last_seq"?: number,"name"?: string,"status"?: Database["public"]['Enums']["client_status"]
                  }
                  Relationships: [
                    
                  ]
                },"dictionary_events": {
                  Row: {
                    "category_id": string | null,"created_at": string,"entry_id": string | null,"seq": number,"type": Database["public"]['Enums']["event_type"]
                  }
                  ComputedFields: never
                  Insert: {
                    "category_id"?: string | null,"created_at"?: string,"entry_id"?: string | null,"seq"?: number,"type": Database["public"]['Enums']["event_type"]
                  }
                  Update: {
                    "category_id"?: string | null,"created_at"?: string,"entry_id"?: string | null,"seq"?: number,"type"?: Database["public"]['Enums']["event_type"]
                  }
                  Relationships: [
                    {
      foreignKeyName: "dictionary_events_category_id_fkey"
      columns: ["category_id"]
isOneToOne: false
      referencedRelation: "categories"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "dictionary_events_category_id_fkey"
      columns: ["category_id"]
isOneToOne: false
      referencedRelation: "v_request_groups"
      referencedColumns: ["current_category_id"]
    },{
      foreignKeyName: "dictionary_events_entry_id_fkey"
      columns: ["entry_id"]
isOneToOne: false
      referencedRelation: "entries"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "dictionary_events_entry_id_fkey"
      columns: ["entry_id"]
isOneToOne: false
      referencedRelation: "v_request_groups"
      referencedColumns: ["entry_id"]
    }
                  ]
                },"engine_settings": {
                  Row: {
                    "alert_pct": number,"auto_publish_daily": number,"batch_size": number,"daily_titles": number,"engine": string,"interval_hours": number,"last_auto_run_at": string | null,"min_reports": number,"mode": string,"model": string,"monthly_budget_usd": number,"paused": boolean,"paused_at": string | null,"paused_reason": string | null,"per_run_searches": number,"provider": string,"timeout_seconds": number,"triggers": NonNullable<Json>,"updated_at": string,"updated_by": string | null
                  }
                  ComputedFields: never
                  Insert: {
                    "alert_pct"?: number,"auto_publish_daily"?: number,"batch_size"?: number,"daily_titles"?: number,"engine": string,"interval_hours"?: number,"last_auto_run_at"?: string | null,"min_reports"?: number,"mode"?: string,"model": string,"monthly_budget_usd"?: number,"paused"?: boolean,"paused_at"?: string | null,"paused_reason"?: string | null,"per_run_searches"?: number,"provider"?: string,"timeout_seconds"?: number,"triggers"?: NonNullable<Json>,"updated_at"?: string,"updated_by"?: string | null
                  }
                  Update: {
                    "alert_pct"?: number,"auto_publish_daily"?: number,"batch_size"?: number,"daily_titles"?: number,"engine"?: string,"interval_hours"?: number,"last_auto_run_at"?: string | null,"min_reports"?: number,"mode"?: string,"model"?: string,"monthly_budget_usd"?: number,"paused"?: boolean,"paused_at"?: string | null,"paused_reason"?: string | null,"per_run_searches"?: number,"provider"?: string,"timeout_seconds"?: number,"triggers"?: NonNullable<Json>,"updated_at"?: string,"updated_by"?: string | null
                  }
                  Relationships: [
                    
                  ]
                },"entries": {
                  Row: {
                    "attention_override": Database["public"]['Enums']["attention_level"] | null,"canonical_name": string,"category_id": string | null,"confidence": number | null,"created_at": string,"description": string | null,"first_reported_at": string | null,"id": string,"kind": Database["public"]['Enums']["entry_kind"],"last_reported_at": string | null,"match_key": string,"method": Database["public"]['Enums']["entry_method"] | null,"model_version": string | null,"reports_count": number,"reviewed_at": string | null,"reviewed_by": string | null,"revision": number,"seq": number,"source": string,"status": Database["public"]['Enums']["entry_status"],"updated_at": string,"vendor": string | null
                  }
                  ComputedFields: never
                  Insert: {
                    "attention_override"?: Database["public"]['Enums']["attention_level"] | null,"canonical_name": string,"category_id"?: string | null,"confidence"?: number | null,"created_at"?: string,"description"?: string | null,"first_reported_at"?: string | null,"id"?: string,"kind": Database["public"]['Enums']["entry_kind"],"last_reported_at"?: string | null,"match_key": string,"method"?: Database["public"]['Enums']["entry_method"] | null,"model_version"?: string | null,"reports_count"?: number,"reviewed_at"?: string | null,"reviewed_by"?: string | null,"revision"?: number,"seq"?: number,"source": string,"status"?: Database["public"]['Enums']["entry_status"],"updated_at"?: string,"vendor"?: string | null
                  }
                  Update: {
                    "attention_override"?: Database["public"]['Enums']["attention_level"] | null,"canonical_name"?: string,"category_id"?: string | null,"confidence"?: number | null,"created_at"?: string,"description"?: string | null,"first_reported_at"?: string | null,"id"?: string,"kind"?: Database["public"]['Enums']["entry_kind"],"last_reported_at"?: string | null,"match_key"?: string,"method"?: Database["public"]['Enums']["entry_method"] | null,"model_version"?: string | null,"reports_count"?: number,"reviewed_at"?: string | null,"reviewed_by"?: string | null,"revision"?: number,"seq"?: number,"source"?: string,"status"?: Database["public"]['Enums']["entry_status"],"updated_at"?: string,"vendor"?: string | null
                  }
                  Relationships: [
                    {
      foreignKeyName: "entries_category_id_fkey"
      columns: ["category_id"]
isOneToOne: false
      referencedRelation: "categories"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "entries_category_id_fkey"
      columns: ["category_id"]
isOneToOne: false
      referencedRelation: "v_request_groups"
      referencedColumns: ["current_category_id"]
    }
                  ]
                },"entry_drafts": {
                  Row: {
                    "attention_override": Database["public"]['Enums']["attention_level"] | null,"canonical_name": string | null,"category_id": string | null,"clear_attention": boolean,"description": string | null,"entry_id": string,"reason": string,"saved_at": string,"saved_by": string | null,"vendor": string | null
                  }
                  ComputedFields: never
                  Insert: {
                    "attention_override"?: Database["public"]['Enums']["attention_level"] | null,"canonical_name"?: string | null,"category_id"?: string | null,"clear_attention"?: boolean,"description"?: string | null,"entry_id": string,"reason": string,"saved_at"?: string,"saved_by"?: string | null,"vendor"?: string | null
                  }
                  Update: {
                    "attention_override"?: Database["public"]['Enums']["attention_level"] | null,"canonical_name"?: string | null,"category_id"?: string | null,"clear_attention"?: boolean,"description"?: string | null,"entry_id"?: string,"reason"?: string,"saved_at"?: string,"saved_by"?: string | null,"vendor"?: string | null
                  }
                  Relationships: [
                    {
      foreignKeyName: "entry_drafts_category_id_fkey"
      columns: ["category_id"]
isOneToOne: false
      referencedRelation: "categories"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "entry_drafts_category_id_fkey"
      columns: ["category_id"]
isOneToOne: false
      referencedRelation: "v_request_groups"
      referencedColumns: ["current_category_id"]
    },{
      foreignKeyName: "entry_drafts_entry_id_fkey"
      columns: ["entry_id"]
isOneToOne: true
      referencedRelation: "entries"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "entry_drafts_entry_id_fkey"
      columns: ["entry_id"]
isOneToOne: true
      referencedRelation: "v_request_groups"
      referencedColumns: ["entry_id"]
    }
                  ]
                },"entry_revisions": {
                  Row: {
                    "change_reason": string | null,"changed_by": string | null,"created_at": string,"entry_id": string,"revision": number,"snapshot": NonNullable<Json>
                  }
                  ComputedFields: never
                  Insert: {
                    "change_reason"?: string | null,"changed_by"?: string | null,"created_at"?: string,"entry_id": string,"revision": number,"snapshot": NonNullable<Json>
                  }
                  Update: {
                    "change_reason"?: string | null,"changed_by"?: string | null,"created_at"?: string,"entry_id"?: string,"revision"?: number,"snapshot"?: NonNullable<Json>
                  }
                  Relationships: [
                    {
      foreignKeyName: "entry_revisions_entry_id_fkey"
      columns: ["entry_id"]
isOneToOne: false
      referencedRelation: "entries"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "entry_revisions_entry_id_fkey"
      columns: ["entry_id"]
isOneToOne: false
      referencedRelation: "v_request_groups"
      referencedColumns: ["entry_id"]
    }
                  ]
                },"hub_members": {
                  Row: {
                    "added_at": string,"email": string,"role": Database["public"]['Enums']["hub_role"],"user_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "added_at"?: string,"email": string,"role": Database["public"]['Enums']["hub_role"],"user_id": string
                  }
                  Update: {
                    "added_at"?: string,"email"?: string,"role"?: Database["public"]['Enums']["hub_role"],"user_id"?: string
                  }
                  Relationships: [
                    
                  ]
                },"notifications": {
                  Row: {
                    "created_at": string,"id": number,"read_at": string | null,"ref_id": string | null,"title": string,"type": string
                  }
                  ComputedFields: never
                  Insert: {
                    "created_at"?: string,"id"?: never,"read_at"?: string | null,"ref_id"?: string | null,"title": string,"type": string
                  }
                  Update: {
                    "created_at"?: string,"id"?: never,"read_at"?: string | null,"ref_id"?: string | null,"title"?: string,"type"?: string
                  }
                  Relationships: [
                    
                  ]
                },"provider_keys": {
                  Row: {
                    "configured_at": string,"configured_by": string | null,"key_hint": string,"provider": string,"secret_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "configured_at"?: string,"configured_by"?: string | null,"key_hint": string,"provider": string,"secret_id": string
                  }
                  Update: {
                    "configured_at"?: string,"configured_by"?: string | null,"key_hint"?: string,"provider"?: string,"secret_id"?: string
                  }
                  Relationships: [
                    
                  ]
                },"reclassification_requests": {
                  Row: {
                    "admin_note": string | null,"client_id": string,"created_at": string,"current_category_id": string | null,"decided_at": string | null,"decided_by": string | null,"entry_id": string,"evidence_url": string | null,"id": string,"public_id": string,"reason": string,"status": Database["public"]['Enums']["request_status"],"suggested_category_id": string | null
                  }
                  ComputedFields: never
                  Insert: {
                    "admin_note"?: string | null,"client_id": string,"created_at"?: string,"current_category_id"?: string | null,"decided_at"?: string | null,"decided_by"?: string | null,"entry_id": string,"evidence_url"?: string | null,"id"?: string,"public_id"?: string,"reason": string,"status"?: Database["public"]['Enums']["request_status"],"suggested_category_id"?: string | null
                  }
                  Update: {
                    "admin_note"?: string | null,"client_id"?: string,"created_at"?: string,"current_category_id"?: string | null,"decided_at"?: string | null,"decided_by"?: string | null,"entry_id"?: string,"evidence_url"?: string | null,"id"?: string,"public_id"?: string,"reason"?: string,"status"?: Database["public"]['Enums']["request_status"],"suggested_category_id"?: string | null
                  }
                  Relationships: [
                    {
      foreignKeyName: "reclassification_requests_client_id_fkey"
      columns: ["client_id"]
isOneToOne: false
      referencedRelation: "client_names"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "reclassification_requests_client_id_fkey"
      columns: ["client_id"]
isOneToOne: false
      referencedRelation: "clients"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "reclassification_requests_current_category_id_fkey"
      columns: ["current_category_id"]
isOneToOne: false
      referencedRelation: "categories"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "reclassification_requests_current_category_id_fkey"
      columns: ["current_category_id"]
isOneToOne: false
      referencedRelation: "v_request_groups"
      referencedColumns: ["current_category_id"]
    },{
      foreignKeyName: "reclassification_requests_entry_id_fkey"
      columns: ["entry_id"]
isOneToOne: false
      referencedRelation: "entries"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "reclassification_requests_entry_id_fkey"
      columns: ["entry_id"]
isOneToOne: false
      referencedRelation: "v_request_groups"
      referencedColumns: ["entry_id"]
    },{
      foreignKeyName: "reclassification_requests_suggested_category_id_fkey"
      columns: ["suggested_category_id"]
isOneToOne: false
      referencedRelation: "categories"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "reclassification_requests_suggested_category_id_fkey"
      columns: ["suggested_category_id"]
isOneToOne: false
      referencedRelation: "v_request_groups"
      referencedColumns: ["current_category_id"]
    }
                  ]
                },"research_dossiers": {
                  Row: {
                    "created_at": string,"created_by": string | null,"dossier": NonNullable<Json>,"entry_id": string,"id": number,"model": string,"provider": string,"trigger": string
                  }
                  ComputedFields: never
                  Insert: {
                    "created_at"?: string,"created_by"?: string | null,"dossier": NonNullable<Json>,"entry_id": string,"id"?: never,"model": string,"provider": string,"trigger": string
                  }
                  Update: {
                    "created_at"?: string,"created_by"?: string | null,"dossier"?: NonNullable<Json>,"entry_id"?: string,"id"?: never,"model"?: string,"provider"?: string,"trigger"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "research_dossiers_entry_id_fkey"
      columns: ["entry_id"]
isOneToOne: false
      referencedRelation: "entries"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "research_dossiers_entry_id_fkey"
      columns: ["entry_id"]
isOneToOne: false
      referencedRelation: "v_request_groups"
      referencedColumns: ["entry_id"]
    }
                  ]
                },"research_queue": {
                  Row: {
                    "created_at": string,"entry_id": string,"error": string | null,"id": number,"processed_at": string | null,"status": string,"trigger": string
                  }
                  ComputedFields: never
                  Insert: {
                    "created_at"?: string,"entry_id": string,"error"?: string | null,"id"?: never,"processed_at"?: string | null,"status"?: string,"trigger": string
                  }
                  Update: {
                    "created_at"?: string,"entry_id"?: string,"error"?: string | null,"id"?: never,"processed_at"?: string | null,"status"?: string,"trigger"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "research_queue_entry_id_fkey"
      columns: ["entry_id"]
isOneToOne: false
      referencedRelation: "entries"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "research_queue_entry_id_fkey"
      columns: ["entry_id"]
isOneToOne: false
      referencedRelation: "v_request_groups"
      referencedColumns: ["entry_id"]
    }
                  ]
                },"submissions": {
                  Row: {
                    "client_id": string,"description": string | null,"id": number,"kind": Database["public"]['Enums']["entry_kind"],"match_key": string,"name": string,"received_at": string,"source": string,"vendor": string | null
                  }
                  ComputedFields: never
                  Insert: {
                    "client_id": string,"description"?: string | null,"id"?: never,"kind": Database["public"]['Enums']["entry_kind"],"match_key": string,"name": string,"received_at"?: string,"source": string,"vendor"?: string | null
                  }
                  Update: {
                    "client_id"?: string,"description"?: string | null,"id"?: never,"kind"?: Database["public"]['Enums']["entry_kind"],"match_key"?: string,"name"?: string,"received_at"?: string,"source"?: string,"vendor"?: string | null
                  }
                  Relationships: [
                    {
      foreignKeyName: "submissions_client_id_fkey"
      columns: ["client_id"]
isOneToOne: false
      referencedRelation: "client_names"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "submissions_client_id_fkey"
      columns: ["client_id"]
isOneToOne: false
      referencedRelation: "clients"
      referencedColumns: ["id"]
    }
                  ]
                }
          }
          Views: {
            "client_names": {
                  Row: {
                    "id": string,"name": string
                  }
                  ComputedFields: never
                  Insert: {
                           "id"?: string | null,"name"?: string | null
                         }
                        Update: {
                           "id"?: string | null,"name"?: string | null
                         }
                        Relationships: [
                    
                  ]
                },"v_missing_prices": {
                  Row: {
                    "engine": string,"model": string,"provider": string
                  }
                  ComputedFields: never
                  Insert: {
                           "engine"?: string | null,"model"?: string | null,"provider"?: string | null
                         }
                        Update: {
                           "engine"?: string | null,"model"?: string | null,"provider"?: string | null
                         }
                        Relationships: [
                    
                  ]
                },"v_proposals": {
                  Row: {
                    "accepted": boolean | null,"attention_level": Database["public"]['Enums']["attention_level"] | null,"canonical_name": string,"category_id": string | null,"category_name": string,"category_slug": string,"current_category_id": string | null,"entry_id": string,"entry_status": Database["public"]['Enums']["entry_status"],"kind": Database["public"]['Enums']["entry_kind"],"level1_name": string | null,"probability": number | null,"reports_count": number,"rerun": boolean,"run_id": string,"source": string,"started_at": string,"vendor": string | null
                  }
                  ComputedFields: never
                  Relationships: [
                    {
      foreignKeyName: "classification_results_category_id_fkey"
      columns: ["category_id"]
isOneToOne: false
      referencedRelation: "categories"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "classification_results_category_id_fkey"
      columns: ["category_id"]
isOneToOne: false
      referencedRelation: "v_request_groups"
      referencedColumns: ["current_category_id"]
    },{
      foreignKeyName: "classification_results_entry_id_fkey"
      columns: ["entry_id"]
isOneToOne: false
      referencedRelation: "entries"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "classification_results_entry_id_fkey"
      columns: ["entry_id"]
isOneToOne: false
      referencedRelation: "v_request_groups"
      referencedColumns: ["entry_id"]
    },{
      foreignKeyName: "classification_results_run_id_fkey"
      columns: ["run_id"]
isOneToOne: false
      referencedRelation: "classification_runs"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "classification_results_run_id_fkey"
      columns: ["run_id"]
isOneToOne: false
      referencedRelation: "v_runs"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "entries_category_id_fkey"
      columns: ["current_category_id"]
isOneToOne: false
      referencedRelation: "categories"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "entries_category_id_fkey"
      columns: ["current_category_id"]
isOneToOne: false
      referencedRelation: "v_request_groups"
      referencedColumns: ["current_category_id"]
    }
                  ]
                },"v_request_groups": {
                  Row: {
                    "canonical_name": string,"clients": number | null,"current_category": string | null,"current_category_id": string | null,"entry_id": string,"entry_status": Database["public"]['Enums']["entry_status"],"items": Json | null,"kind": Database["public"]['Enums']["entry_kind"],"newest": string | null,"oldest": string | null,"requests": number | null,"source": string,"vendor": string | null
                  }
                  ComputedFields: never
                  Relationships: [
                    
                  ]
                },"v_runs": {
                  Row: {
                    "auto_published": number | null,"cost_usd": number | null,"entry_count": number,"errors": number | null,"finished_at": string | null,"id": string,"model": string,"open_proposals": number | null,"rerun": boolean,"results": number | null,"started_at": string,"started_by": string | null,"status": Database["public"]['Enums']["run_status"]
                  }
                  ComputedFields: never
                  Insert: {
                           "auto_published"?: never,"cost_usd"?: never,"entry_count"?: number | null,"errors"?: never,"finished_at"?: string | null,"id"?: string | null,"model"?: string | null,"open_proposals"?: never,"rerun"?: boolean | null,"results"?: never,"started_at"?: string | null,"started_by"?: string | null,"status"?: Database["public"]['Enums']["run_status"] | null
                         }
                        Update: {
                           "auto_published"?: never,"cost_usd"?: never,"entry_count"?: number | null,"errors"?: never,"finished_at"?: string | null,"id"?: string | null,"model"?: string | null,"open_proposals"?: never,"rerun"?: boolean | null,"results"?: never,"started_at"?: string | null,"started_by"?: string | null,"status"?: Database["public"]['Enums']["run_status"] | null
                         }
                        Relationships: [
                    
                  ]
                }
          }
          Functions: {
            "accept_all_above":
{ Args: { "p_min"?: number }; Returns: number
                           },
"access_role_for":
{ Args: { "p_email": string }; Returns: Database["public"]['Enums']["hub_role"]
                           },
"add_access_rule":
{ Args: { "p_kind": string,"p_role": Database["public"]['Enums']["hub_role"],"p_value": string }; Returns: string
                           },
"admin_pause_engine":
{ Args: { "p_engine": string }; Returns: undefined
                           },
"build_digest":
{ Args: Record<PropertyKey, never>; Returns: Json
                           },
"can_curate":
{ Args: Record<PropertyKey, never>; Returns: boolean
                           },
"check_jev_acceptance":
{ Args: Record<PropertyKey, never>; Returns: undefined
                           },
"clear_provider_key":
{ Args: { "p_provider": string }; Returns: undefined
                           },
"client_call":
{ Args: { "p_key_hash": string }; Returns: {
              "client_id": string,"client_name": string,"retry_after": number,"status": number
            }[]
                           },
"create_client":
{ Args: { "p_contact_email": string,"p_name": string }; Returns: {
              "client_id": string,"client_key": string
            }[]
                           },
"decide_entry_requests":
{ Args: { "p_accept": boolean,"p_category_id"?: string,"p_entry_id": string,"p_note": string }; Returns: number
                           },
"decide_proposal":
{ Args: { "p_accept": boolean,"p_category_id"?: string,"p_entry_id": string,"p_run_id": string }; Returns: string
                           },
"delete_access_rule":
{ Args: { "p_id": string }; Returns: undefined
                           },
"deprecate_category":
{ Args: { "p_category_id": string,"p_reason": string,"p_replacement_id": string }; Returns: number
                           },
"dictionary_changes":
{ Args: { "p_client_id": string,"p_limit"?: number,"p_since": number }; Returns: Json
                           },
"discard_entry_draft":
{ Args: { "p_entry_id": string }; Returns: undefined
                           },
"engine_gate":
{ Args: { "p_engine": string,"p_manual": boolean,"p_units": number }; Returns: Json
                           },
"engine_status":
{ Args: { "p_engine": string }; Returns: {
              "auto_publish_daily": number,"auto_published_today": number,"daily_titles": number,"engine": string,"last_auto_run_at": string,"mode": string,"model": string,"monthly_budget_usd": number,"paused": boolean,"paused_at": string,"paused_reason": string,"spend_month": number,"titles_today": number
            }[]
                           },
"engine_usage":
{ Args: { "p_engine": string }; Returns: {
              "calls_hour": number,"errors_hour": number,"spend_month": number,"titles_today": number
            }[]
                           },
"engine_usage_detail":
{ Args: { "p_engine": string }; Returns: Json
                           },
"enqueue_research":
{ Args: { "p_entry_id": string,"p_trigger": string }; Returns: boolean
                           },
"ensure_hub_member":
{ Args: { "p_email": string }; Returns: boolean
                           },
"get_provider_key":
{ Args: { "p_provider": string }; Returns: string
                           },
"hub_admin_emails":
{ Args: Record<PropertyKey, never>; Returns: string[]
                           },
"hub_role":
{ Args: Record<PropertyKey, never>; Returns: Database["public"]['Enums']["hub_role"]
                           },
"invoke_digest":
{ Args: Record<PropertyKey, never>; Returns: number
                           },
"invoke_jev":
{ Args: Record<PropertyKey, never>; Returns: number
                           },
"invoke_research":
{ Args: Record<PropertyKey, never>; Returns: number
                           },
"is_hub_admin":
{ Args: Record<PropertyKey, never>; Returns: boolean
                           },
"is_hub_member":
{ Args: Record<PropertyKey, never>; Returns: boolean
                           },
"jev_finish_run":
{ Args: { "p_run_id": string,"p_status": Database["public"]['Enums']["run_status"] }; Returns: undefined
                           },
"jev_gate":
{ Args: { "p_manual": boolean,"p_titles": number }; Returns: Json
                           },
"jev_start_run":
{ Args: { "p_entry_ids": (string)[],"p_model": string,"p_rerun": boolean,"p_started_by": string }; Returns: string
                           },
"jev_store_result":
{ Args: { "p_category_slug": string,"p_entry_id": string,"p_probability": number,"p_run_id": string }; Returns: string
                           },
"list_users":
{ Args: Record<PropertyKey, never>; Returns: {
              "access": string,"added_at": string,"email": string,"id": string,"last_sign_in_at": string,"role": Database["public"]['Enums']["hub_role"]
            }[]
                           },
"new_client_key":
{ Args: Record<PropertyKey, never>; Returns: string
                           },
"open_reclassification_request":
{ Args: { "p_client_id": string,"p_evidence_url": string,"p_kind": string,"p_match_key": string,"p_reason": string,"p_source": string,"p_suggested_category_id": string }; Returns: Json
                           },
"pause_engine":
{ Args: { "p_engine": string,"p_reason": string }; Returns: undefined
                           },
"publish_entry":
{ Args: { "p_actor": string,"p_category_id": string,"p_confidence": number,"p_entry_id": string,"p_method": Database["public"]['Enums']["entry_method"],"p_model_version": string,"p_reason": string,"p_status"?: Database["public"]['Enums']["entry_status"] }; Returns: number
                           },
"publish_entry_edit":
{ Args: { "p_entry_id": string,"p_reason"?: string }; Returns: number
                           },
"record_ai_call":
{ Args: { "p_cache_read": number,"p_cache_write": number,"p_engine": string,"p_entry_ids"?: (string)[],"p_error"?: string,"p_http_status"?: number,"p_input": number,"p_latency_ms": number,"p_model": string,"p_output": number,"p_provider"?: string,"p_purpose": string,"p_run_id": string,"p_searches"?: number,"p_status": string,"p_titles": number }; Returns: Json
                           },
"remove_user":
{ Args: { "p_user_id": string }; Returns: undefined
                           },
"request_statuses":
{ Args: { "p_client_id": string,"p_ids": (string)[] }; Returns: Json
                           },
"research_failed":
{ Args: { "p_error": string,"p_queue_id": number }; Returns: undefined
                           },
"research_take":
{ Args: { "p_limit": number }; Returns: {
              "entry_id": string,"queue_id": number,"trigger": string
            }[]
                           },
"resume_engine":
{ Args: { "p_engine": string }; Returns: undefined
                           },
"revert_auto_publish":
{ Args: { "p_entry_id": string }; Returns: string
                           },
"revoke_client":
{ Args: { "p_client_id": string }; Returns: undefined
                           },
"rotate_client_key":
{ Args: { "p_client_id": string }; Returns: string
                           },
"save_entry_draft":
{ Args: { "p_attention": Database["public"]['Enums']["attention_level"],"p_category_id": string,"p_clear_attention": boolean,"p_description": string,"p_entry_id": string,"p_name": string,"p_reason": string,"p_vendor": string }; Returns: undefined
                           },
"search_entries":
{ Args: { "p_category_id"?: string,"p_kind"?: Database["public"]['Enums']["entry_kind"],"p_limit"?: number,"p_offset"?: number,"p_query"?: string,"p_sort"?: string,"p_status"?: Database["public"]['Enums']["entry_status"] }; Returns: {
              "attention_level": Database["public"]['Enums']["attention_level"],"canonical_name": string,"category_id": string,"category_name": string,"confidence": number,"has_draft": boolean,"id": string,"kind": Database["public"]['Enums']["entry_kind"],"level1_name": string,"match_key": string,"method": Database["public"]['Enums']["entry_method"],"open_requests": number,"reports_count": number,"revision": number,"source": string,"status": Database["public"]['Enums']["entry_status"],"total_count": number,"vendor": string
            }[]
                           },
"set_engine_config":
{ Args: { "p_daily": number,"p_engine": string,"p_model": string,"p_monthly_budget": number,"p_provider": string,"p_triggers"?: Json }; Returns: undefined
                           },
"set_engine_mode":
{ Args: { "p_engine": string,"p_mode": string }; Returns: undefined
                           },
"set_price":
{ Args: { "p_cache_read": number,"p_cache_write": number,"p_engine": string,"p_input": number,"p_model": string,"p_output": number,"p_per_search": number,"p_provider": string }; Returns: undefined
                           },
"set_provider_key":
{ Args: { "p_key": string,"p_provider": string }; Returns: undefined
                           },
"set_user_role":
{ Args: { "p_role": Database["public"]['Enums']["hub_role"],"p_user_id": string }; Returns: undefined
                           },
"submit_titles":
{ Args: { "p_client_id": string,"p_titles": Json }; Returns: Json
                           },
"update_category":
{ Args: { "p_category_id": string,"p_description": string,"p_name": string,"p_reason": string }; Returns: number
                           }
          }
          Enums: {
            "attention_level": "info"|"review"|"not_allowed","client_status": "active"|"revoked","entry_kind": "program"|"extension"|"ide_extension"|"package","entry_method": "rule"|"jev"|"jev_auto"|"manual","entry_status": "pending"|"proposed"|"published"|"deprecated","event_type": "published"|"reclassified"|"description_changed"|"deprecated"|"category_changed","hub_role": "admin"|"operator"|"viewer","request_status": "open"|"accepted"|"rejected"|"superseded","run_status": "running"|"finished"|"failed"|"cancelled"
          }
          CompositeTypes: {
            [_ in never]: never
          }
        }
}

type DatabaseWithoutInternals = Omit<Database, '__InternalSupabase'>

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never
> = DefaultSchemaTableNameOrOptions extends { schema: keyof DatabaseWithoutInternals }
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
  ? (DefaultSchema["Tables"] & DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
      Row: infer R
    }
    ? R
    : never
  : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never
> = DefaultSchemaTableNameOrOptions extends { schema: keyof DatabaseWithoutInternals }
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
  ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
      Insert: infer I
    }
    ? I
    : never
  : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never
> = DefaultSchemaTableNameOrOptions extends { schema: keyof DatabaseWithoutInternals }
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
  ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
      Update: infer U
    }
    ? U
    : never
  : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never
> = DefaultSchemaEnumNameOrOptions extends { schema: keyof DatabaseWithoutInternals }
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
  ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
  : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never
> = PublicCompositeTypeNameOrOptions extends { schema: keyof DatabaseWithoutInternals }
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
  ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
  : never

export const Constants = {
  "graphql_public": {
          Enums: {
            
          }
        },"public": {
          Enums: {
            "attention_level": ["info", "review", "not_allowed"],"client_status": ["active", "revoked"],"entry_kind": ["program", "extension", "ide_extension", "package"],"entry_method": ["rule", "jev", "jev_auto", "manual"],"entry_status": ["pending", "proposed", "published", "deprecated"],"event_type": ["published", "reclassified", "description_changed", "deprecated", "category_changed"],"hub_role": ["admin", "operator", "viewer"],"request_status": ["open", "accepted", "rejected", "superseded"],"run_status": ["running", "finished", "failed", "cancelled"]
          }
        }
} as const
