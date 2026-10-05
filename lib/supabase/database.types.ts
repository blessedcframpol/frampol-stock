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
          timezone: string
          updated_at: string
          updated_by: string | null
        }
        Insert: {
          id?: boolean
          default_reorder_level?: number
          low_stock_emails_enabled?: boolean
          low_stock_recipients?: string[]
          timezone?: string
          updated_at?: string
          updated_by?: string | null
        }
        Update: {
          id?: boolean
          default_reorder_level?: number
          low_stock_emails_enabled?: boolean
          low_stock_recipients?: string[]
          timezone?: string
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
          reserved_for_request_line_id: string | null
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
          reserved_for_request_line_id?: string | null
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
          reserved_for_request_line_id?: string | null
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
          reorder_level: number | null
          is_active: boolean
        }
        Insert: {
          id: string
          product_name: string
          vendor?: string
          created_at?: string
          requires_serial?: boolean
          reorder_level?: number | null
          is_active?: boolean
        }
        Update: {
          id?: string
          product_name?: string
          vendor?: string
          created_at?: string
          requires_serial?: boolean
          reorder_level?: number | null
          is_active?: boolean
        }
        Relationships: []
      }
      stock_requests: {
        Row: {
          id: string
          client_id: string
          created_by: string
          status: string
          quotation_url: string | null
          notes: string | null
          serviced_at: string | null
          invoice_number: string | null
          invoice_document_url: string | null
          invoiced_at: string | null
          invoiced_by: string | null
          created_at: string
          updated_at: string
        }
        Insert: {
          id?: string
          client_id: string
          created_by: string
          status?: string
          quotation_url?: string | null
          notes?: string | null
          serviced_at?: string | null
          invoice_number?: string | null
          invoice_document_url?: string | null
          invoiced_at?: string | null
          invoiced_by?: string | null
          created_at?: string
          updated_at?: string
        }
        Update: {
          id?: string
          client_id?: string
          created_by?: string
          status?: string
          quotation_url?: string | null
          notes?: string | null
          serviced_at?: string | null
          invoice_number?: string | null
          invoice_document_url?: string | null
          invoiced_at?: string | null
          invoiced_by?: string | null
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
          company: string
          email: string
          phone: string | null
          address: string | null
          sites: { name?: string; address: string }[] | null
          total_orders: number
          total_spent: number
          last_order: string | null
        }
        Insert: {
          id: string
          name: string
          company: string
          email: string
          phone?: string | null
          address?: string | null
          sites?: { name?: string; address: string }[] | null
          total_orders?: number
          total_spent?: number
          last_order?: string | null
        }
        Update: {
          id?: string
          name?: string
          company?: string
          email?: string
          phone?: string | null
          address?: string | null
          sites?: { name?: string; address: string }[] | null
          total_orders?: number
          total_spent?: number
          last_order?: string | null
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
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
    Functions: {
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
      change_stock_pool: {
        Args: { p_item_id: string; p_pool: string; p_reason: string }
        Returns: undefined
      }
      change_stock_pools: {
        Args: { p_item_ids: string[]; p_pool: string; p_reason: string }
        Returns: undefined
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
      assign_serial_to_request_line: {
        Args: { p_line_id: string; p_inventory_item_id: string }
        Returns: undefined
      }
      release_serial_from_request_line: {
        Args: { p_inventory_item_id: string }
        Returns: undefined
      }
      create_request_serviced_notification: {
        Args: { p_request_id: string }
        Returns: undefined
      }
    }
  }
}
