'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';
import * as api from '@/lib/api';
import { Button, Input, Alert } from '@/components/base';

interface CommodityMapping {
  keyword: string;
  groupId: number;
  categoryName: string;
  groupName: string;
}

export default function CommodityMappingsPage() {
  const [mappings, setMappings] = useState<CommodityMapping[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');

  const [newKeyword, setNewKeyword] = useState('');
  const [newGroupId, setNewGroupId] = useState<number | ''>('');
  const [commodityGroups, setCommodityGroups] = useState<api.CommodityGroup[]>([]);
  const [searchTerm, setSearchTerm] = useState('');
  const [savingMapping, setSavingMapping] = useState(false);

  useEffect(() => {
    loadData();
  }, []);

  const loadData = async () => {
    setLoading(true);
    try {
      const [settings, groups] = await Promise.all([
        api.organizations.getSettings(),
        api.commodityGroups.list(),
      ]);

      setCommodityGroups(groups);

      // Convert settings mappings to CommodityMapping[]
      const mappingsList: CommodityMapping[] = Object.entries(
        settings.commodity_group_mappings || {}
      ).map(([keyword, groupId]) => {
        const group = groups.find((g) => g.id === groupId);
        return {
          keyword,
          groupId,
          categoryName: group?.category || 'Unknown',
          groupName: group?.name || 'Unknown',
        };
      });

      setMappings(mappingsList);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load mappings');
    }
    setLoading(false);
  };

  const handleAddMapping = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setSuccess('');

    if (!newKeyword.trim()) {
      setError('Please enter a keyword');
      return;
    }

    if (!newGroupId) {
      setError('Please select a commodity group');
      return;
    }

    // Check for duplicates
    if (mappings.some((m) => m.keyword.toLowerCase() === newKeyword.toLowerCase())) {
      setError('This keyword already has a mapping');
      return;
    }

     setSavingMapping(true);

     try {
       // Build updated mappings
       const updatedMappings: Record<string, number> = {};
       mappings.forEach((m) => {
         updatedMappings[m.keyword] = m.groupId;
       });
       updatedMappings[newKeyword.toLowerCase()] = Number(newGroupId);

       // Get current settings to preserve them
       const currentSettings = await api.organizations.getSettings();

       // Save via PATCH
       await api.organizations.updateSettings({
         required_fields: currentSettings.required_fields || [],
         enable_commodity_group_mappings: currentSettings.enable_commodity_group_mappings,
         commodity_group_mappings: updatedMappings,
       });

      // Add to local state
      const group = commodityGroups.find((g) => g.id === newGroupId);
      setMappings([
        ...mappings,
        {
          keyword: newKeyword.toLowerCase(),
          groupId: Number(newGroupId),
          categoryName: group?.category || 'Unknown',
          groupName: group?.name || 'Unknown',
        },
      ]);

      setSuccess(`Mapping added: "${newKeyword}" → ${group?.id} - ${group?.category} - ${group?.name}`);
      setNewKeyword('');
      setNewGroupId('');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to add mapping');
    } finally {
      setSavingMapping(false);
    }
  };

  const handleDeleteMapping = async (keyword: string) => {
    if (!window.confirm(`Delete mapping for "${keyword}"?`)) {
      return;
    }

    try {
      // Build updated mappings without this keyword
      const updatedMappings: Record<string, number> = {};
      mappings.forEach((m) => {
        if (m.keyword !== keyword) {
          updatedMappings[m.keyword] = m.groupId;
        }
      });

       // Get current settings to preserve them
       const currentSettings = await api.organizations.getSettings();

       // Save via PATCH
       await api.organizations.updateSettings({
         required_fields: currentSettings.required_fields || [],
         enable_commodity_group_mappings: currentSettings.enable_commodity_group_mappings,
         commodity_group_mappings: updatedMappings,
       });

       setMappings(mappings.filter((m) => m.keyword !== keyword));
       setSuccess(`Mapping deleted: "${keyword}"`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete mapping');
    }
  };

  const filteredMappings = mappings.filter(
    (m) =>
      m.keyword.includes(searchTerm.toLowerCase()) ||
      m.categoryName.toLowerCase().includes(searchTerm.toLowerCase()) ||
      m.groupName.toLowerCase().includes(searchTerm.toLowerCase())
  );

  if (loading) {
    return (
      <div className="max-w-[1600px] mx-auto px-4 sm:px-6 lg:px-8 py-8">
        <div className="flex items-center justify-center h-64">
          <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-accent-deep"></div>
        </div>
      </div>
    );
  }

  return (
    <div className="max-w-[1600px] mx-auto px-4 sm:px-6 lg:px-8 py-8">
      {/* Header */}
      <div className="mb-8">
        <div className="flex items-center gap-2 mb-2 text-sm">
          <Link href="/dashboard/organization" className="text-accent-deep hover:underline">
            Organization
          </Link>
          <span className="text-ink/40">/</span>
          <span className="text-ink">Custom Commodity Mappings</span>
        </div>
        <h1 className="text-3xl font-semibold tracking-tight text-ink">
          Custom Commodity Mappings
        </h1>
        <p className="text-ink/55 mt-1.5">
          Map keywords to commodity groups for automatic classification during extraction · {mappings.length} mappings
        </p>
      </div>

      {error && (
        <Alert variant="error" className="mb-6">
          {error}
        </Alert>
      )}
      {success && (
        <Alert variant="success" className="mb-6">
          {success}
        </Alert>
      )}

      {/* Add New Mapping Form */}
      <div className="lio-card p-6 mb-6">
        <h2 className="text-xl font-semibold tracking-tight text-ink mb-4">
          Add New Custom Commodity Mapping
        </h2>
        <form onSubmit={handleAddMapping} className="flex flex-col sm:flex-row gap-3">
          <Input
            type="text"
            value={newKeyword}
            onChange={(e) => setNewKeyword(e.target.value)}
            placeholder="e.g., cable ties, printer toner"
            className="flex-1"
            disabled={savingMapping}
          />
          <select
            value={newGroupId}
            onChange={(e) => setNewGroupId(e.target.value ? Number(e.target.value) : '')}
            disabled={savingMapping}
            className="h-11 md:max-w-sm w-full px-3.5 border border-line rounded-xl text-sm text-ink bg-white focus:outline-none focus:ring-2 focus:ring-accent-deep/60 focus:border-accent-deep/40"
          >
            <option value="">
              {commodityGroups.length > 0 ? 'Select commodity group...' : 'Loading...'}
            </option>
            {commodityGroups.map((group) => (
              <option key={group.id} value={group.id}>
                {group.id} - {group.category} - {group.name}
              </option>
            ))}
          </select>
          <Button
            type="submit"
            loading={savingMapping}
            disabled={savingMapping}
            className="min-w-[140px]"
          >
            Add Mapping
          </Button>
        </form>
      </div>

      {/* Search and Mappings Table */}
      <div className="lio-card overflow-hidden">
        <div className="p-4 border-b border-line">
          <div className="flex flex-col md:flex-row gap-4 md:items-center">
            <div className="flex-1">
              <Input
                placeholder="Search mappings by keyword or commodity group…"
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
              />
            </div>
            <span className="text-sm text-ink/45 md:w-28 md:text-right">
              {filteredMappings.length} shown
            </span>
          </div>
        </div>

        {mappings.length === 0 ? (
          <div className="p-12 text-center text-ink/50">No custom mappings configured yet. Add one above.</div>
        ) : filteredMappings.length === 0 ? (
          <div className="p-12 text-center text-ink/50">No mappings match your search.</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead className="bg-ink-800/[0.03] border-b border-line">
                <tr>
                  {['Keyword', 'Category', 'Commodity Group', 'ID', 'Actions'].map((h) => (
                    <th
                      key={h}
                      className="px-6 py-3 text-left text-xs font-medium text-ink/45 uppercase tracking-wider"
                    >
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {filteredMappings.map((mapping) => (
                  <tr key={mapping.keyword} className="hover:bg-ink-800/[0.02]">
                    <td className="px-6 py-4 whitespace-nowrap">
                      <div className="text-sm font-medium text-ink font-mono">{mapping.keyword}</div>
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap">
                      <span className="inline-flex px-2.5 py-1 text-xs font-medium rounded-full bg-accent-soft/30 text-accent-deep">
                        {mapping.categoryName}
                      </span>
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap">
                      <div className="text-sm text-ink/70">{mapping.groupName}</div>
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap text-sm text-ink/70 font-mono">
                      {mapping.groupId}
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap text-sm">
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => handleDeleteMapping(mapping.keyword)}
                        className="text-red-600 hover:bg-red-50"
                      >
                        Delete
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
