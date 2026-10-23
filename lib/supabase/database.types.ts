export type Json = string | number | boolean | null | { [key: string]: Json | undefined } | Json[]

export interface Database {
  public: {
    Tables: {
      app_settings: {
        Row: {
          id: boolean
          default_reorder_level: number
          low_stock_emails_enabled: boolean
          low_stock_recipients: string[]
          problem_report_recipient_ids: string[]
          audit_report_recipient_ids: string[]
          problem_report_recipient_migration_skipped: string[]
          audit_report_recipient_migration_skipped: string[]
          atlas_link_required: boolean
          timezone: string
          internal_client_id: string | null
          updated_at: string
          updated_by: string | null
        }
        Insert: {
          id?: boolean
          default_reorder_level?: number
          low_stock_emails_enabled?: boolean
          low_stock_recipients?: string[]
          problem_report_recipient_ids?: string[]
          audit_report_recipient_ids?: string[]
          problem_report_recipient_migration_skipped?: string[]
          audit_report_recipient_migration_skipped?: string[]
          atlas_link_required?: boolean
          timezone?: string
          internal_client_id?: string | null
          updated_at?: string
          updated_by?: string | null
        }
        Update: {
          id?: boolean
          default_reorder_level?: number
          low_stock_emails_enabled?: boolean
          low_stock_recipients?: string[]
          problem_report_recipient_ids?: string[]
          audit_report_recipient_ids?: string[]
          problem_report_recipient_migration_skipped?: string[]
          audit_report_recipient_migration_skipped?: string[]
          atlas_link_required?: boolean
          timezone?: string
          internal_client_id?: string | null
          updated_at?: string
          updated_by?: string | null
        }
        Relationships: []
      }
      app_event_logs: {
        Row: {
          id: string
          created_at: string
          severity: string
          source: string
          context: string
          message: string
          detail: string | null
          metadata: Json | null
          user_id: string | null
          request_id: string | null
        }
        Insert: {
          id?: string
          created_at?: string
          severity: string
          source: string
          context: string
          message: string
          detail?: string | null
          metadata?: Json | null
          user_id?: string | null
          request_id?: string | null
        }
        Update: {
          id?: string
          created_at?: string
          severity?: string
          source?: string
          context?: string
          message?: string
          detail?: string | null
          metadata?: Json | null
          user_id?: string | null
          request_id?: string | null
        }
        Relationships: []
      }
      inventory_items: {
        Row: {
          id: string
          product_id: string
          serial_number: string
          status: string
          stock_pool: string
          date_added: string
          location: string
          client: string | null
          notes: string | null
          assigned_to: string | null
          purchase_date: string | null
          warranty_end_date: string | null
          poc_out_date: string | null
          return_date: string | null
          assignment_history: Json | null
          cloud_key: string | null
          deleted_at: string | null
        }
        Insert: {
          id: string
          product_id: string
          serial_number: string
          status: string
          stock_pool?: string
          date_added: string
          location: string
          client?: string | null
          notes?: string | null
          cloud_key?: string | null
          assigned_to?: string | null
          purchase_date?: string | null
          warranty_end_date?: string | null
          poc_out_date?: string | null
          return_date?: string | null
          assignment_history?: Json | null
          deleted_at?: string | null
        }
        Update: {
          id?: string
          product_id?: string
          serial_number?: string
          status?: string
          stock_pool?: string
          date_added?: string
          location?: string
          client?: string | null
          notes?: string | null
          assigned_to?: string | null
          purchase_date?: string | null
          warranty_end_date?: string | null
          poc_out_date?: string | null
          return_date?: string | null
          assignment_history?: Json | null
          cloud_key?: string | null
          deleted_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "inventory_items_product_id_fkey"
            columns: ["product_id"]
            isOneToOne: false
            referencedRelation: "product_lines"
            referencedColumns: ["id"]
          },
        ]
      }
      stock_pool_changes: {
        Row: {
          id: string
          inventory_item_id: string
          serial_number: string
          from_pool: string
          to_pool: string
          reason: string
          changed_by: string
          changed_at: string
        }
        Insert: {
          id?: string
          inventory_item_id: string
          serial_number: string
          from_pool: string
          to_pool: string
          reason: string
          changed_by: string
          changed_at?: string
        }
        Update: {
          id?: string
          inventory_item_id?: string
          serial_number?: string
          from_pool?: string
          to_pool?: string
          reason?: string
          changed_by?: string
          changed_at?: string
        }
        Relationships: []
      }
      product_lines: {
        Row: {
          id: string
          product_name: string
          vendor: string
          created_at: string
          requires_serial: boolean
          requires_cloud_key: boolean
          reorder_level: number | null
          is_active: boolean
        }
        Insert: {
          id: string
          product_name: string
          vendor?: string
          created_at?: string
          requires_serial?: boolean
          requires_cloud_key?: boolean
          reorder_level?: number | null
          is_active?: boolean
        }
        Update: {
          id?: string
          product_name?: string
          vendor?: string
          created_at?: string
          requires_serial?: boolean
          requires_cloud_key?: boolean
          reorder_level?: number | null
          is_active?: boolean
        }
        Relationships: []
      }
      stock_requests: {
        Row: {
          id: string
          request_number: string
          client_id: string
          created_by: string
          review_state: string
          type: string
          return_date: string | null
          atlas_task_url: string | null
          atlas_task_id: string | null
          atlas_link_pending: boolean
          quotation_url: string | null
          notes: string | null
          submitted_at: string
          invoice_status: string
          invoice_number: string | null
          not_invoiced_reason: string | null
          not_invoiced_kind: string | null
          invoice_approval: string | null
          invoice_entered_by: string | null
          invoice_entered_at: string | null
          invoice_approved_by: string | null
          invoice_approved_at: string | null
          reject_reason_code: string | null
          reject_note: string | null
          rejected_by: string | null
          rejected_at: string | null
          closed_reason: string | null
          closed_by: string | null
          closed_at: string | null
          cancel_reason: string | null
          cancelled_by: string | null
          cancelled_at: string | null
          issue_lock_user_id: string | null
          issue_lock_since: string | null
          created_at: string
          updated_at: string
        }
        Insert: {
          id?: string
          request_number?: string
          client_id: string
          created_by: string
          review_state?: string
          type: string
          return_date?: string | null
          atlas_task_url?: string | null
          atlas_task_id?: string | null
          atlas_link_pending?: boolean
          quotation_url?: string | null
          notes?: string | null
          submitted_at?: string
          invoice_status: string
          invoice_number?: string | null
          not_invoiced_reason?: string | null
          not_invoiced_kind?: string | null
          invoice_approval?: string | null
          invoice_entered_by?: string | null
          invoice_entered_at?: string | null
          invoice_approved_by?: string | null
          invoice_approved_at?: string | null
          reject_reason_code?: string | null
          reject_note?: string | null
          rejected_by?: string | null
          rejected_at?: string | null
          closed_reason?: string | null
          closed_by?: string | null
          closed_at?: string | null
          cancel_reason?: string | null
          cancelled_by?: string | null
          cancelled_at?: string | null
          issue_lock_user_id?: string | null
          issue_lock_since?: string | null
          created_at?: string
          updated_at?: string
        }
        Update: {
          id?: string
          request_number?: string
          client_id?: string
          created_by?: string
          review_state?: string
          type?: string
          return_date?: string | null
          atlas_task_url?: string | null
          atlas_task_id?: string | null
          atlas_link_pending?: boolean
          quotation_url?: string | null
          notes?: string | null
          submitted_at?: string
          invoice_status?: string
          invoice_number?: string | null
          not_invoiced_reason?: string | null
          not_invoiced_kind?: string | null
          invoice_approval?: string | null
          invoice_entered_by?: string | null
          invoice_entered_at?: string | null
          invoice_approved_by?: string | null
          invoice_approved_at?: string | null
          reject_reason_code?: string | null
          reject_note?: string | null
          rejected_by?: string | null
          rejected_at?: string | null
          closed_reason?: string | null
          closed_by?: string | null
          closed_at?: string | null
          cancel_reason?: string | null
          cancelled_by?: string | null
          cancelled_at?: string | null
          issue_lock_user_id?: string | null
          issue_lock_since?: string | null
          created_at?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "stock_requests_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "clients"
            referencedColumns: ["id"]
          },
        ]
      }
      stock_request_lines: {
        Row: {
          id: string
          request_id: string
          product_name: string
          product_id: string
          quantity_requested: number
          sort_order: number
        }
        Insert: {
          id?: string
          request_id: string
          product_name: string
          product_id: string
          quantity_requested: number
          sort_order?: number
        }
        Update: {
          id?: string
          request_id?: string
          product_name?: string
          product_id?: string
          quantity_requested?: number
          sort_order?: number
        }
        Relationships: [
          {
            foreignKeyName: "stock_request_lines_request_id_fkey"
            columns: ["request_id"]
            isOneToOne: false
            referencedRelation: "stock_requests"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "stock_request_lines_product_id_fkey"
            columns: ["product_id"]
            isOneToOne: false
            referencedRelation: "product_lines"
            referencedColumns: ["id"]
          },
        ]
      }
      notifications: {
        Row: {
          id: string
          user_id: string
          type: string
          title: string
          body: string | null
          read_at: string | null
          metadata: Json
          created_at: string
        }
        Insert: {
          id?: string
          user_id: string
          type: string
          title: string
          body?: string | null
          read_at?: string | null
          metadata?: Json
          created_at?: string
        }
        Update: {
          id?: string
          user_id?: string
          type?: string
          title?: string
          body?: string | null
          read_at?: string | null
          metadata?: Json
          created_at?: string
        }
        Relationships: []
      }
      problem_reports: {
        Row: {
          id: string
          report_number: string
          created_by: string
          what_happened: string
          what_expected: string | null
          screenshot_path: string | null
          page_url: string
          reporter_role: string | null
          browser: string | null
          device: string | null
          context: Json
          status: "open" | "in_progress" | "resolved"
          resolution_note: string | null
          resolved_by: string | null
          resolved_at: string | null
          created_at: string
          updated_at: string
        }
        Insert: {
          id?: string
          report_number?: string
          created_by: string
          what_happened: string
          what_expected?: string | null
          screenshot_path?: string | null
          page_url: string
          reporter_role?: string | null
          browser?: string | null
          device?: string | null
          context?: Json
          status?: "open" | "in_progress" | "resolved"
          resolution_note?: string | null
          resolved_by?: string | null
          resolved_at?: string | null
          created_at?: string
          updated_at?: string
        }
        Update: {
          id?: string
          report_number?: string
          created_by?: string
          what_happened?: string
          what_expected?: string | null
          screenshot_path?: string | null
          page_url?: string
          reporter_role?: string | null
          browser?: string | null
          device?: string | null
          context?: Json
          status?: "open" | "in_progress" | "resolved"
          resolution_note?: string | null
          resolved_by?: string | null
          resolved_at?: string | null
          created_at?: string
          updated_at?: string
        }
        Relationships: []
      }
      transactions: {
        Row: {
          id: string
          type: string
          serial_number: string
          item_name: string
          client: string
          date: string
          client_id: string | null
          invoice_number: string | null
          notes: string | null
          from_location: string | null
          to_location: string | null
          assigned_to: string | null
          disposal_reason: string | null
          authorised_by: string | null
          batch_id: string | null
          delivery_note_url: string | null
          metadata: Json | null
          created_by: string | null
          created_at: string | null
          previous_status: string | null
          previous_status_source: string
          previous_location: string | null
          previous_client: string | null
          previous_assigned_to: string | null
          previous_poc_out_date: string | null
          previous_return_date: string | null
          previous_stock_pool: string | null
          after_status: string | null
          after_location: string | null
          after_client: string | null
          after_assigned_to: string | null
          after_poc_out_date: string | null
          after_return_date: string | null
          after_stock_pool: string | null
          reverses_transaction_id: string | null
          request_id: string | null
          request_line_id: string | null
        }
        Insert: {
          id: string
          type: string
          serial_number: string
          item_name: string
          client: string
          date: string
          created_at?: string | null
          client_id?: string | null
          disposal_reason?: string | null
          authorised_by?: string | null
          batch_id?: string | null
          delivery_note_url?: string | null
          invoice_number?: string | null
          notes?: string | null
          from_location?: string | null
          to_location?: string | null
          assigned_to?: string | null
          metadata?: Json | null
          created_by?: string | null
          previous_status?: string | null
          previous_status_source?: string
          previous_location?: string | null
          previous_client?: string | null
          previous_assigned_to?: string | null
          previous_poc_out_date?: string | null
          previous_return_date?: string | null
          previous_stock_pool?: string | null
          after_status?: string | null
          after_location?: string | null
          after_client?: string | null
          after_assigned_to?: string | null
          after_poc_out_date?: string | null
          after_return_date?: string | null
          after_stock_pool?: string | null
          reverses_transaction_id?: string | null
          request_id?: string | null
          request_line_id?: string | null
        }
        Update: {
          id?: string
          type?: string
          serial_number?: string
          item_name?: string
          client?: string
          date?: string
          client_id?: string | null
          disposal_reason?: string | null
          authorised_by?: string | null
          invoice_number?: string | null
          notes?: string | null
          from_location?: string | null
          to_location?: string | null
          assigned_to?: string | null
          batch_id?: string | null
          delivery_note_url?: string | null
          metadata?: Json | null
          created_by?: string | null
          created_at?: string | null
          previous_status?: string | null
          previous_status_source?: string
          previous_location?: string | null
          previous_client?: string | null
          previous_assigned_to?: string | null
          previous_poc_out_date?: string | null
          previous_return_date?: string | null
          previous_stock_pool?: string | null
          after_status?: string | null
          after_location?: string | null
          after_client?: string | null
          after_assigned_to?: string | null
          after_poc_out_date?: string | null
          after_return_date?: string | null
          after_stock_pool?: string | null
          reverses_transaction_id?: string | null
          request_id?: string | null
          request_line_id?: string | null
        }
        Relationships: []
      }
      kit_cases: {
        Row: {
          id: string
          case_type: string
          inventory_item_id: string
          client_id: string | null
          source_transaction_id: string
          reason_category: string
          reason_text: string
          stage: string
          outcome: string | null
          opened_at: string
          opened_by: string | null
          closed_at: string | null
          closed_by: string | null
        }
        Insert: {
          id?: string
          case_type: string
          inventory_item_id: string
          client_id?: string | null
          source_transaction_id: string
          reason_category: string
          reason_text: string
          stage: string
          outcome?: string | null
          opened_at?: string
          opened_by?: string | null
          closed_at?: string | null
          closed_by?: string | null
        }
        Update: {
          id?: string
          case_type?: string
          inventory_item_id?: string
          client_id?: string | null
          source_transaction_id?: string
          reason_category?: string
          reason_text?: string
          stage?: string
          outcome?: string | null
          opened_at?: string
          opened_by?: string | null
          closed_at?: string | null
          closed_by?: string | null
        }
        Relationships: []
      }
      kit_case_events: {
        Row: {
          id: string
          case_id: string
          event_type: string
          actor: string | null
          at: string
          payload: Json
          reason: string | null
        }
        Insert: {
          id?: string
          case_id: string
          event_type: string
          actor?: string | null
          at?: string
          payload?: Json
          reason?: string | null
        }
        Update: {
          id?: string
          case_id?: string
          event_type?: string
          actor?: string | null
          at?: string
          payload?: Json
          reason?: string | null
        }
        Relationships: []
      }
      kit_inspections: {
        Row: {
          id: string
          inventory_item_id: string
          serial_number: string
          inspector_name: string | null
          inspected_at: string
          outcome: string
          condition_notes: string | null
          attachment_urls: string[]
          transaction_id: string | null
          created_by: string | null
          created_at: string
        }
        Insert: {
          id?: string
          inventory_item_id: string
          serial_number: string
          inspector_name?: string | null
          inspected_at?: string
          outcome: string
          condition_notes?: string | null
          attachment_urls?: string[]
          transaction_id?: string | null
          created_by?: string | null
          created_at?: string
        }
        Update: {
          id?: string
          inventory_item_id?: string
          serial_number?: string
          inspector_name?: string | null
          inspected_at?: string
          outcome?: string
          condition_notes?: string | null
          attachment_urls?: string[]
          transaction_id?: string | null
          created_by?: string | null
          created_at?: string
        }
        Relationships: []
      }
      remediation_providers: {
        Row: {
          id: string
          slug: string
          display_name: string
          created_at: string
        }
        Insert: {
          id?: string
          slug: string
          display_name: string
          created_at?: string
        }
        Update: {
          id?: string
          slug?: string
          display_name?: string
          created_at?: string
        }
        Relationships: []
      }
      remediation_cases: {
        Row: {
          id: string
          provider_id: string
          faulty_inventory_item_id: string
          faulty_serial: string
          loaner_inventory_item_id: string | null
          loaner_serial: string | null
          provider_replacement_inventory_item_id: string | null
          provider_replacement_serial: string | null
          status: string
          date_sent_to_provider: string | null
          date_replacement_received: string | null
          tracking_reference: string | null
          notes: string | null
          created_by: string | null
          created_at: string
          updated_at: string
        }
        Insert: {
          id?: string
          provider_id: string
          faulty_inventory_item_id: string
          faulty_serial: string
          loaner_inventory_item_id?: string | null
          loaner_serial?: string | null
          provider_replacement_inventory_item_id?: string | null
          provider_replacement_serial?: string | null
          status?: string
          date_sent_to_provider?: string | null
          date_replacement_received?: string | null
          tracking_reference?: string | null
          notes?: string | null
          created_by?: string | null
          created_at?: string
          updated_at?: string
        }
        Update: {
          id?: string
          provider_id?: string
          faulty_inventory_item_id?: string
          faulty_serial?: string
          loaner_inventory_item_id?: string | null
          loaner_serial?: string | null
          provider_replacement_inventory_item_id?: string | null
          provider_replacement_serial?: string | null
          status?: string
          date_sent_to_provider?: string | null
          date_replacement_received?: string | null
          tracking_reference?: string | null
          notes?: string | null
          created_by?: string | null
          created_at?: string
          updated_at?: string
        }
        Relationships: []
      }
      outbound_batches: {
        Row: {
          id: string
          type: string
          client: string | null
          client_id: string | null
          start_date: string
          end_date: string | null
          status: string
          invoice_number: string | null
          created_at: string
        }
        Insert: {
          id: string
          type: string
          client?: string | null
          client_id?: string | null
          start_date: string
          end_date?: string | null
          status?: string
          invoice_number?: string | null
          created_at: string
        }
        Update: {
          id?: string
          type?: string
          client?: string | null
          client_id?: string | null
          start_date?: string
          end_date?: string | null
          status?: string
          invoice_number?: string | null
          created_at?: string
        }
        Relationships: []
      }
      clients: {
        Row: {
          id: string
          name: string
          company: string | null
          email: string
          phone: string | null
          address: string | null
          sites: { name?: string; address: string }[] | null
          total_orders: number
          total_spent: number
          last_order: string | null
          duplicate_override_reason: string | null
        }
        Insert: {
          id: string
          name: string
          company?: string | null
          email: string
          phone?: string | null
          address?: string | null
          sites?: { name?: string; address: string }[] | null
          total_orders?: number
          total_spent?: number
          last_order?: string | null
          duplicate_override_reason?: string | null
        }
        Update: {
          id?: string
          name?: string
          company?: string | null
          email?: string
          phone?: string | null
          address?: string | null
          sites?: { name?: string; address: string }[] | null
          total_orders?: number
          total_spent?: number
          last_order?: string | null
          duplicate_override_reason?: string | null
        }
        Relationships: []
      }
      batch_reversals: {
        Row: {
          batch_id: string
          reversed_at: string
          reversal_reason: string | null
          reversed_by: string | null
          kind: string
        }
        Insert: {
          batch_id: string
          reversed_at: string
          reversal_reason?: string | null
          reversed_by?: string | null
          kind?: string
        }
        Update: {
          batch_id?: string
          reversed_at?: string
          reversal_reason?: string | null
          reversed_by?: string | null
          kind?: string
        }
        Relationships: []
      }
      batch_restores: {
        Row: {
          id: number
          batch_id: string
          restored_at: string
          restore_reason: string
          restored_by: string | null
        }
        Insert: {
          id?: number
          batch_id: string
          restored_at?: string
          restore_reason: string
          restored_by?: string | null
        }
        Update: {
          id?: number
          batch_id?: string
          restored_at?: string
          restore_reason?: string
          restored_by?: string | null
        }
        Relationships: []
      }
      holding_extensions: {
        Row: {
          id: string
          item_id: string
          serial_number: string
          holding_type: string
          previous_date: string | null
          new_date: string
          reason: string
          extended_by: string
          created_at: string
          cancelled_at: string | null
          cancelled_by: string | null
          cancel_reason: string | null
        }
        Insert: {
          id?: string
          item_id: string
          serial_number: string
          holding_type: string
          previous_date?: string | null
          new_date: string
          reason: string
          extended_by: string
          created_at?: string
          cancelled_at?: string | null
          cancelled_by?: string | null
          cancel_reason?: string | null
        }
        Update: {
          id?: string
          item_id?: string
          serial_number?: string
          holding_type?: string
          previous_date?: string | null
          new_date?: string
          reason?: string
          extended_by?: string
          created_at?: string
          cancelled_at?: string | null
          cancelled_by?: string | null
          cancel_reason?: string | null
        }
        Relationships: []
      }
      stock_takes: {
        Row: {
          id: string
          completed_at: string
          result_snapshot: Json
        }
        Insert: {
          id: string
          completed_at: string
          result_snapshot: Json
        }
        Update: {
          id?: string
          completed_at?: string
          result_snapshot?: Json
        }
        Relationships: []
      }
      batch_invoices: {
        Row: {
          batch_id: string
          status: string
          invoice_number: string | null
          not_invoiced_reason: string | null
          not_invoiced_kind: string | null
          entered_by: string | null
          entered_at: string | null
          approval: string | null
          approved_by: string | null
          approved_at: string | null
          rejection_reason: string | null
          legacy: boolean
        }
        Insert: {
          batch_id: string
          status: string
          invoice_number?: string | null
          not_invoiced_reason?: string | null
          not_invoiced_kind?: string | null
          entered_by?: string | null
          entered_at?: string | null
          approval?: string | null
          approved_by?: string | null
          approved_at?: string | null
          rejection_reason?: string | null
          legacy?: boolean
        }
        Update: {
          batch_id?: string
          status?: string
          invoice_number?: string | null
          not_invoiced_reason?: string | null
          not_invoiced_kind?: string | null
          entered_by?: string | null
          entered_at?: string | null
          approval?: string | null
          approved_by?: string | null
          approved_at?: string | null
          rejection_reason?: string | null
          legacy?: boolean
        }
        Relationships: []
      }
      batch_invoice_events: {
        Row: {
          id: string
          batch_id: string
          old_status: string | null
          new_status: string | null
          old_invoice_number: string | null
          new_invoice_number: string | null
          old_approval: string | null
          new_approval: string | null
          actor_id: string | null
          reason: string | null
          created_at: string
        }
        Insert: {
          id?: string
          batch_id: string
          old_status?: string | null
          new_status?: string | null
          old_invoice_number?: string | null
          new_invoice_number?: string | null
          old_approval?: string | null
          new_approval?: string | null
          actor_id?: string | null
          reason?: string | null
          created_at?: string
        }
        Update: {
          id?: string
          batch_id?: string
          old_status?: string | null
          new_status?: string | null
          old_invoice_number?: string | null
          new_invoice_number?: string | null
          old_approval?: string | null
          new_approval?: string | null
          actor_id?: string | null
          reason?: string | null
          created_at?: string
        }
        Relationships: []
      }
      profiles: {
        Row: {
          id: string
          email: string
          display_name: string | null
          role: string | null
          active: boolean
          created_at: string
          updated_at: string
        }
        Insert: {
          id: string
          email: string
          display_name?: string | null
          role?: string | null
          active?: boolean
          created_at?: string
          updated_at?: string
        }
        Update: {
          id?: string
          email?: string
          display_name?: string | null
          role?: string | null
          active?: boolean
          created_at?: string
          updated_at?: string
        }
        Relationships: []
      }
      stock_request_events: {
        Row: {
          id: string
          request_id: string
          created_at: string
          actor_id: string | null
          event_type: string
          from_status: string | null
          to_status: string | null
          payload: Json
        }
        Insert: {
          id?: string
          request_id: string
          created_at?: string
          actor_id?: string | null
          event_type: string
          from_status?: string | null
          to_status?: string | null
          payload?: Json
        }
        Update: {
          id?: string
          request_id?: string
          created_at?: string
          actor_id?: string | null
          event_type?: string
          from_status?: string | null
          to_status?: string | null
          payload?: Json
        }
        Relationships: [
          {
            foreignKeyName: "stock_request_events_request_id_fkey"
            columns: ["request_id"]
            isOneToOne: false
            referencedRelation: "stock_requests"
            referencedColumns: ["id"]
          },
        ]
      }
    }
    Views: {
      batch_request_context: {
        Row: {
          batch_id: string
          request_id: string
          request_number: string
          requester_name: string
          atlas_task_url: string | null
        }
        Relationships: []
      }
      batch_invoice_list: {
        Row: {
          batch_id: string
          status: string
          invoice_number: string | null
          not_invoiced_reason: string | null
          entered_by: string | null
          entered_at: string | null
          approval: string | null
          approved_by: string | null
          approved_at: string | null
          rejection_reason: string | null
          legacy: boolean
          movement_type: string | null
          client_name: string | null
          quantity: number
          serials: string | null
          product_name: string | null
          sale_date: string | null
          days_waiting: number | null
        }
        Relationships: []
      }
      active_transactions: {
        Row: {
          id: string
          type: string
          serial_number: string
          item_name: string
          client: string
          date: string
          client_id: string | null
          invoice_number: string | null
          notes: string | null
          from_location: string | null
          to_location: string | null
          assigned_to: string | null
          disposal_reason: string | null
          authorised_by: string | null
          batch_id: string | null
          delivery_note_url: string | null
          metadata: Json | null
          created_by: string | null
          created_at: string | null
          previous_status: string | null
          previous_status_source: string
          previous_location: string | null
          previous_client: string | null
          previous_assigned_to: string | null
          previous_poc_out_date: string | null
          previous_return_date: string | null
          previous_stock_pool: string | null
          after_status: string | null
          after_location: string | null
          after_client: string | null
          after_assigned_to: string | null
          after_poc_out_date: string | null
          after_return_date: string | null
          after_stock_pool: string | null
          reverses_transaction_id: string | null
          request_id: string | null
          request_line_id: string | null
        }
        Relationships: []
      }
      kit_case_list: {
        Row: {
          id: string
          case_type: string
          stage: string
          outcome: string | null
          reason_category: string
          reason_text: string
          opened_at: string
          closed_at: string | null
          opened_by: string | null
          closed_by: string | null
          client_id: string | null
          inventory_item_id: string
          serial_number: string
          kit_status: string
          stock_pool: string
          location: string | null
          holder: string | null
          product_id: string | null
          product_name: string | null
          vendor: string | null
          source_type: string
          source_label: string
          client_name: string | null
          client_company: string | null
          grade: string | null
          result: string | null
          comments: string | null
          closed_by_name: string | null
        }
        Relationships: []
      }
      low_stock_products: {
        Row: {
          product_id: string
          product_name: string
          vendor: string
          in_stock_count: number
          effective_reorder_level: number
          is_low: boolean
        }
        Relationships: []
      }
    }
    Enums: {
      problem_report_status: "open" | "in_progress" | "resolved"
    }
    CompositeTypes: {
      [_ in never]: never
    }
    Functions: {
      batch_request_context_for: {
        Args: { p_batch_ids: string[] }
        Returns: {
          batch_id: string
          request_id: string
          request_number: string
          requester_name: string
          atlas_task_url: string | null
        }[]
      }
      batch_movement_history: {
        Args: { p_batch_id: string }
        Returns: Json
      }
      transaction_batch_page: {
        Args: {
          p_limit: number
          p_offset: number
          p_movement?: string | null
          p_from?: string | null
          p_to?: string | null
          p_search?: string | null
          p_active_only?: boolean
        }
        Returns: Json
      }
      profile_display_labels: {
        Args: { p_ids: string[] }
        Returns: { id: string; label: string }[]
      }
      stock_availability: {
        Args: { p_query?: string | null }
        Returns: {
          product_id: string
          product_name: string
          vendor: string | null
          available_count: number
          reorder_level: number
          is_low: boolean
        }[]
      }
      product_catalogue: {
        Args: Record<string, never>
        Returns: {
          product_id: string
          product_name: string
          vendor: string | null
          is_active: boolean
          requires_cloud_key: boolean
        }[]
      }
      atlas_task_id_from_url: {
        Args: { p_url: string }
        Returns: string
      }
      atlas_task_url_ok: {
        Args: { p_url: string }
        Returns: boolean
      }
      client_last_activity: {
        Args: Record<string, never>
        Returns: {
          client_id: string
          last_activity_date: string | null
        }[]
      }
      client_transactions: {
        Args: { p_client_id: string }
        Returns: {
          id: string
          type: string
          serial_number: string
          item_name: string
          client: string
          date: string
          client_id: string | null
          invoice_number: string | null
          notes: string | null
          from_location: string | null
          to_location: string | null
          assigned_to: string | null
          disposal_reason: string | null
          authorised_by: string | null
          batch_id: string | null
          delivery_note_url: string | null
          metadata: Json | null
          created_by: string | null
          created_at: string | null
          batch_key: string
        }[]
      }
      client_sale_dispatch_counts: {
        Args: Record<string, never>
        Returns: {
          client_id: string
          orders: number | null
          units: number | null
          reliable: boolean
        }[]
      }
      dispatched_page: {
        Args: {
          p_limit: number
          p_offset: number
          p_movement?: string | null
          p_from?: string | null
          p_to?: string | null
          p_search?: string | null
        }
        Returns: Json
      }
      log_stock_request_event: {
        Args: {
          p_request_id: string
          p_event_type: string
          p_from_status?: string | null
          p_to_status?: string | null
          p_payload?: Json
          p_actor_id?: string | null
        }
        Returns: undefined
      }
      movement_result_status: {
        Args: { p_status: string; p_type: string }
        Returns: string
      }
      extend_holding: {
        Args: { p_item_id: string; p_new_date: string; p_reason: string }
        Returns: undefined
      }
      cancel_holding_extension: {
        Args: { p_extension_id: string; p_reason: string }
        Returns: undefined
      }
      set_batch_invoice: {
        Args: {
          p_batch_id: string
          p_choice: string
          p_invoice_number: string
          p_reason: string
          p_kind?: string | null
        }
        Returns: undefined
      }
      approve_batch_invoice: {
        Args: { p_batch_id: string }
        Returns: undefined
      }
      reject_batch_invoice: {
        Args: { p_batch_id: string; p_reason: string }
        Returns: undefined
      }
      complete_inspection: {
        Args: {
          p_case_id: string
          p_result: string
          p_comments: string
          p_grade: string
          p_outcome: string
          p_location?: string | null
          p_reason_category?: string | null
        }
        Returns: string
      }
      change_stock_pool: {
        Args: { p_item_id: string; p_pool: string; p_reason: string }
        Returns: undefined
      }
      change_stock_pools: {
        Args: { p_item_ids: string[]; p_pool: string; p_reason: string }
        Returns: undefined
      }
      bulk_resolve_holdings: {
        Args: { p_rows: Json }
        Returns: Json
      }
      kit_history: {
        Args: { p_item_id: string }
        Returns: Json
      }
      returns_report: {
        Args: { p_from: string; p_to: string }
        Returns: Json
      }
      apply_inventory_edit: {
        Args: { p_id: string; p_patch: Json; p_reason: string; p_source: string }
        Returns: undefined
      }
      audit_log_read: {
        Args: {
          p_table?: string | null
          p_row?: string | null
          p_user?: string | null
          p_from?: string | null
          p_to?: string | null
          p_action?: string | null
        }
        Returns: Json
      }
      auth_sign_ins_read: {
        Args: {
          p_user?: string | null
          p_from?: string | null
          p_to?: string | null
        }
        Returns: Json
      }
      record_sign_in: {
        Args: {
          p_ip?: string | null
          p_user_agent?: string | null
        }
        Returns: number
      }
      set_user_access: {
        Args: {
          p_profile_id: string
          p_role: string
          p_active: boolean
          p_display_name?: string | null
          p_reason?: string | null
        }
        Returns: Json
      }
      archive_product: {
        Args: {
          p_product_id: string
          p_reason: string
        }
        Returns: Json
      }
      restore_product: {
        Args: {
          p_product_id: string
          p_reason: string
        }
        Returns: Json
      }
      delete_product: {
        Args: {
          p_product_id: string
          p_reason: string
        }
        Returns: Json
      }
      profile_last_sign_ins: {
        Args: Record<string, never>
        Returns: Json
      }
      submit_problem_report: {
        Args: {
          p_what_happened: string
          p_what_expected?: string | null
          p_screenshot_path?: string | null
          p_page_url?: string | null
          p_browser?: string | null
          p_device?: string | null
          p_context?: Json
        }
        Returns: Json
      }
      update_problem_report_status: {
        Args: {
          p_id: string
          p_status: "open" | "in_progress" | "resolved"
          p_resolution_note?: string | null
        }
        Returns: Json
      }
      audit_exceptions_read: {
        Args: {
          p_from?: string | null
          p_to?: string | null
        }
        Returns: Json
      }
      verify_audit_chain: {
        Args: {
          p_from_seq?: number | null
          p_to_seq?: number | null
        }
        Returns: { broken_seq: number; detail: string }[]
      }
      apply_stock_movement: {
        Args: {
          p_inventory_upserts: Json
          p_inventory_inserts: Json
          p_transactions: Json
          p_outbound_batch?: Json
          p_kit_inspection?: Json
          p_remediation_patch?: Json
        }
        Returns: undefined
      }
      reverse_quick_scan_batch: {
        Args: {
          p_batch_id: string
          p_reason: string
          p_return_location?: string
          p_confirmed?: Json
          p_entered?: Json
        }
        Returns: Json
      }
      reverse_restore_plan: {
        Args: { p_batch_id: string }
        Returns: Json
      }
      restore_batch_plan: {
        Args: { p_batch_id: string }
        Returns: Json
      }
      restore_batch: {
        Args: { p_batch_id: string; p_reason: string }
        Returns: Json
      }
      batch_is_currently_reversed: {
        Args: { p_batch_id: string }
        Returns: boolean
      }
      void_batch: {
        Args: { p_batch_id: string; p_reason: string }
        Returns: Json
      }
      ensure_product_line: {
        Args: { p_product_name: string; p_vendor: string }
        Returns: string
      }
      begin_request_issue: {
        Args: { p_request_id: string }
        Returns: Json
      }
      touch_request_issue: {
        Args: { p_request_id: string }
        Returns: undefined
      }
      end_request_issue: {
        Args: { p_request_id: string }
        Returns: undefined
      }
      take_over_request_issue: {
        Args: { p_request_id: string }
        Returns: Json
      }
      stock_request_fresh_issue_locks: {
        Args: { p_request_ids: string[] }
        Returns: {
          request_id: string
          issue_lock_active_user_id: string | null
          issue_lock_active_since: string | null
        }[]
      }
      set_atlas_link_required: {
        Args: { p_required: boolean; p_reason: string }
        Returns: undefined
      }
      set_request_atlas_link: {
        Args: { p_request_id: string; p_url: string }
        Returns: undefined
      }
      find_client_duplicate_candidates: {
        Args: { p_email: string; p_phone: string; p_name: string }
        Returns: {
          id: string
          name: string
          company: string | null
          email: string
          phone: string | null
          match_on: string[]
        }[]
      }
      submit_request: {
        Args: { p_payload: Json }
        Returns: string
      }
      approve_not_invoiced: {
        Args: { p_request_id: string }
        Returns: undefined
      }
      reject_request: {
        Args: { p_request_id: string; p_code: string; p_note?: string | null }
        Returns: undefined
      }
      resubmit_request: {
        Args: { p_request_id: string; p_changes: Json }
        Returns: undefined
      }
      cancel_request: {
        Args: { p_request_id: string; p_reason?: string | null }
        Returns: undefined
      }
      preview_issue_scan: {
        Args: {
          p_request_id: string
          p_serial: string
          p_already_scanned?: string[]
          p_cloud_key?: string | null
        }
        Returns: Json
      }
      issue_units: {
        Args: { p_request_id: string; p_scans: Json }
        Returns: Json
      }
      close_outstanding: {
        Args: { p_request_id: string; p_reason: string }
        Returns: undefined
      }
      set_request_invoice: {
        Args: {
          p_request_id: string
          p_choice: string
          p_invoice_number?: string | null
          p_reason?: string | null
          p_kind?: string | null
        }
        Returns: undefined
      }
      request_display_status: {
        Args: { p_request_id: string }
        Returns: string
      }
    }
  }
}
