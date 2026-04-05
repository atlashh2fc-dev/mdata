'use client'

import { useState, useRef } from 'react'
import { Search, X, Filter, SlidersHorizontal } from 'lucide-react'

interface SearchBarProps {
  value: string
  onChange: (value: string) => void
  onSearch: () => void
  placeholder?: string
  onToggleFilters?: () => void
  showFiltersToggle?: boolean
  isLoading?: boolean
}

export function SearchBar({
  value,
  onChange,
  onSearch,
  placeholder = 'Buscar por RUT, nombre o email...',
  onToggleFilters,
  showFiltersToggle = false,
  isLoading = false,
}: SearchBarProps) {
  const inputRef = useRef<HTMLInputElement>(null)

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'Enter') onSearch()
  }

  return (
    <div className="flex items-center gap-2">
      <div className="relative flex-1">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-500" />
        <input
          ref={inputRef}
          type="text"
          value={value}
          onChange={e => onChange(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={placeholder}
          className="input-base pl-9 pr-9"
        />
        {value && (
          <button
            onClick={() => { onChange(''); inputRef.current?.focus() }}
            className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-500 hover:text-white transition-colors"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        )}
        {isLoading && (
          <div className="absolute right-3 top-1/2 -translate-y-1/2">
            <div className="w-4 h-4 border-2 border-brand-500/20 border-t-brand-500 rounded-full animate-spin" />
          </div>
        )}
      </div>

      <button onClick={onSearch} className="btn-primary px-5">
        Buscar
      </button>

      {showFiltersToggle && (
        <button onClick={onToggleFilters} className="btn-secondary">
          <SlidersHorizontal className="w-4 h-4" />
          Filtros
        </button>
      )}
    </div>
  )
}
