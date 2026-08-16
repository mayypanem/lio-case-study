'use client';

import { useEffect, useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import * as api from '@/lib/api';
import type { Supplier, ArticleCreateInput } from '@/lib/api';
import { Button, Input, Alert } from '@/components/base';

interface ArticleCreationFormProps {
  onSuccess?: () => void;
  onCancel?: () => void;
}

export function ArticleCreationForm({ onSuccess, onCancel }: ArticleCreationFormProps) {
  const [suppliers, setSuppliers] = useState<Supplier[]>([]);
  const [loadingSuppliers, setLoadingSuppliers] = useState(true);
  const [error, setError] = useState('');

  // Form fields
  const [articleNumber, setArticleNumber] = useState('');
  const [supplierId, setSupplierId] = useState('');
  const [description, setDescription] = useState('');
  const [unitPrice, setUnitPrice] = useState('');
  const [currency, setCurrency] = useState('EUR');
  const [unit, setUnit] = useState('');
  const [quantity, setQuantity] = useState('1');

  // Load suppliers
  useEffect(() => {
    const load = async () => {
      try {
        const result = await api.suppliers.list();
        setSuppliers(result);
        setError('');
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to load suppliers');
      } finally {
        setLoadingSuppliers(false);
      }
    };
    load();
  }, []);

  // Create article mutation
  const createMutation = useMutation({
    mutationFn: async () => {
      if (!articleNumber.trim()) throw new Error('Article number is required');
      if (!supplierId) throw new Error('Supplier is required');
      if (!description.trim()) throw new Error('Description is required');
      if (!unitPrice.trim()) throw new Error('Unit price is required');
      if (!unit.trim()) throw new Error('Unit is required');

      const data: ArticleCreateInput = {
        article_number: articleNumber.trim(),
        supplier_id: supplierId,
        description: description.trim(),
        unit_price: unitPrice.trim(),
        currency,
        unit: unit.trim(),
        quantity: quantity.trim() || '1',
      };

      return api.articles.create(data);
    },
    onSuccess: () => {
      setArticleNumber('');
      setSupplierId('');
      setDescription('');
      setUnitPrice('');
      setCurrency('EUR');
      setUnit('');
      setQuantity('1');
      setError('');
      onSuccess?.();
    },
    onError: (err) => {
      setError(err instanceof Error ? err.message : 'Failed to create article');
    },
  });

  return (
    <div className="space-y-4">
      {error && <Alert variant="error">{error}</Alert>}

      {/* Article Number */}
      <div>
        <label className="block text-sm font-medium text-ink mb-1.5">
          Article Number *
        </label>
        <Input
          placeholder="e.g. SKU-2024-001"
          value={articleNumber}
          onChange={(e) => setArticleNumber(e.target.value)}
          disabled={createMutation.isPending}
        />
      </div>

      {/* Supplier */}
      <div>
        <label className="block text-sm font-medium text-ink mb-1.5">
          Supplier *
        </label>
        {loadingSuppliers ? (
          <div className="h-11 flex items-center text-sm text-ink/50">Loading suppliers...</div>
        ) : (
          <select
            value={supplierId}
            onChange={(e) => setSupplierId(e.target.value)}
            disabled={createMutation.isPending}
            className="w-full h-11 px-3.5 border border-line rounded-xl text-sm text-ink bg-white focus:outline-none focus:ring-2 focus:ring-accent-deep/60 focus:border-accent-deep/40 disabled:opacity-50"
          >
            <option value="">Select a supplier...</option>
            {suppliers.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        )}
      </div>

      {/* Description */}
      <div>
        <label className="block text-sm font-medium text-ink mb-1.5">
          Description *
        </label>
        <Input
          placeholder="Article description"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          disabled={createMutation.isPending}
        />
      </div>

      {/* Unit Price and Currency */}
      <div className="grid grid-cols-3 gap-3">
        <div className="col-span-2">
          <label className="block text-sm font-medium text-ink mb-1.5">
            Unit Price *
          </label>
          <Input
            type="number"
            step="0.01"
            placeholder="0.00"
            value={unitPrice}
            onChange={(e) => setUnitPrice(e.target.value)}
            disabled={createMutation.isPending}
          />
        </div>
        <div>
          <label className="block text-sm font-medium text-ink mb-1.5">
            Currency
          </label>
          <select
            value={currency}
            onChange={(e) => setCurrency(e.target.value)}
            disabled={createMutation.isPending}
            className="w-full h-11 px-3.5 border border-line rounded-xl text-sm text-ink bg-white focus:outline-none focus:ring-2 focus:ring-accent-deep/60 focus:border-accent-deep/40 disabled:opacity-50"
          >
            <option value="EUR">EUR</option>
            <option value="USD">USD</option>
            <option value="GBP">GBP</option>
            <option value="CHF">CHF</option>
            <option value="SEK">SEK</option>
          </select>
        </div>
      </div>

      {/* Unit and Quantity */}
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="block text-sm font-medium text-ink mb-1.5">
            Unit *
          </label>
          <Input
            placeholder="e.g. piece, month, hour"
            value={unit}
            onChange={(e) => setUnit(e.target.value)}
            disabled={createMutation.isPending}
          />
        </div>
        <div>
          <label className="block text-sm font-medium text-ink mb-1.5">
            Quantity
          </label>
          <Input
            type="number"
            step="0.01"
            placeholder="1"
            value={quantity}
            onChange={(e) => setQuantity(e.target.value)}
            disabled={createMutation.isPending}
          />
        </div>
      </div>

      {/* Buttons */}
      <div className="flex items-center gap-2 pt-2">
        <Button
          variant="primary"
          onClick={() => createMutation.mutate()}
          loading={createMutation.isPending}
          disabled={loadingSuppliers}
          className="flex-1"
        >
          Create Article
        </Button>
        <Button
          variant="outline"
          onClick={onCancel}
          disabled={createMutation.isPending}
        >
          Cancel
        </Button>
      </div>
    </div>
  );
}
